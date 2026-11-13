//! Soniox response / token / state normalisation. No network, no secrets.

use cutline_core::soniox::*;
use cutline_core::time::SourceTime;

fn tok(text: &str, start: i64, end: i64) -> SonioxToken {
    SonioxToken {
        text: text.into(),
        start_ms: Some(start),
        end_ms: Some(end),
        confidence: Some(0.9),
        ..Default::default()
    }
}

fn spk(mut t: SonioxToken, speaker: &str) -> SonioxToken {
    t.speaker = Some(speaker.into());
    t
}

fn lang(mut t: SonioxToken, language: &str) -> SonioxToken {
    t.language = Some(language.into());
    t
}

fn conf(mut t: SonioxToken, c: f64) -> SonioxToken {
    t.confidence = Some(c);
    t
}

fn texts(t: &cutline_core::transcript::Transcript) -> Vec<&str> {
    t.words.iter().map(|w| w.text.as_str()).collect()
}

// ---------------------------------------------------------------------------------
// tokens → words
// ---------------------------------------------------------------------------------

#[test]
fn merges_subword_tokens_and_attaches_punctuation() {
    let tokens = vec![
        conf(tok("Hel", 10, 90), 0.95),
        conf(tok("lo", 110, 160), 0.98),
        conf(tok(",", 160, 160), 0.10),
        conf(tok(" wor", 200, 300), 0.80),
        conf(tok("ld", 300, 400), 0.60),
        conf(tok("!", 400, 420), 0.99),
    ];
    let t = tokens_to_transcript("a1", "soniox", DEFAULT_MODEL, false, &tokens);
    assert_eq!(texts(&t), ["Hello,", "world!"]);
    let (hello, world) = (&t.words[0], &t.words[1]);
    assert_eq!((hello.index, world.index), (0, 1));
    assert_eq!(
        (hello.start, hello.end),
        (SourceTime::from_ms(10), SourceTime::from_ms(160))
    );
    // punctuation does not extend the spoken range …
    assert_eq!(
        (world.start, world.end),
        (SourceTime::from_ms(200), SourceTime::from_ms(400))
    );
    // … nor does it count towards confidence
    assert!((hello.confidence.unwrap() - 0.965).abs() < 1e-9);
    assert!((world.confidence.unwrap() - 0.70).abs() < 1e-9);
    // words point back into the raw token vector (punctuation included)
    assert_eq!((hello.token_start, hello.token_end), (0, 3));
    assert_eq!((world.token_start, world.token_end), (3, 6));
    assert_eq!(t.asset_id, "a1");
    assert_eq!(t.provider, "soniox");
    assert_eq!(t.model, "stt-async-v5");
    assert!(!t.fixture);
}

#[test]
fn raw_tokens_are_preserved_verbatim() {
    let mut translation = tok(" hola", 0, 0);
    translation.translation_status = Some("translation".into());
    translation.start_ms = None;
    translation.end_ms = None;
    let tokens = vec![
        spk(lang(conf(tok("Hi", 5, 50), 0.5), "en"), "2"),
        translation.clone(),
        tok("", 60, 70),
        tok(" <end>", 70, 70),
    ];
    let t = tokens_to_transcript("a", "soniox", "m", false, &tokens);
    assert_eq!(t.tokens.len(), tokens.len());
    for (raw, src) in t.tokens.iter().zip(&tokens) {
        assert_eq!(raw.text, src.text);
        assert_eq!(raw.start_ms, src.start_ms);
        assert_eq!(raw.end_ms, src.end_ms);
        assert_eq!(raw.confidence, src.confidence);
        assert_eq!(raw.speaker, src.speaker);
        assert_eq!(raw.language, src.language);
    }
    // but only the spoken token became a word
    assert_eq!(texts(&t), ["Hi"]);
    assert_eq!(t.words[0].speaker.as_deref(), Some("2"));
    assert_eq!(t.words[0].language.as_deref(), Some("en"));
}

#[test]
fn skips_translations_untimed_and_marker_tokens() {
    let mut translated = tok(" bonjour", 100, 200);
    translated.translation_status = Some("translation".into());
    let mut untimed = tok(" ghost", 0, 0);
    untimed.start_ms = None;
    let mut event = tok(" [laughter]", 300, 400);
    event.is_audio_event = Some(true);
    let mut original = tok(" there", 220, 300);
    original.translation_status = Some("original".into());
    let tokens = vec![
        tok("Hello", 0, 90),
        translated,
        untimed,
        original,
        event,
        tok("<end>", 400, 400),
        tok(" friend", 420, 500),
    ];
    let t = tokens_to_transcript("a", "soniox", "m", false, &tokens);
    assert_eq!(texts(&t), ["Hello", "there", "friend"]);
    assert_eq!((t.words[1].token_start, t.words[1].token_end), (3, 4));
}

#[test]
fn untimed_token_does_not_glue_neighbours_together() {
    let mut untimed = tok(" lost", 0, 0);
    untimed.end_ms = None;
    // "ly" would normally continue the previous word; after a dropped word it must not
    let tokens = vec![tok("real", 0, 100), untimed, tok("ly", 200, 300)];
    let t = tokens_to_transcript("a", "soniox", "m", false, &tokens);
    assert_eq!(texts(&t), ["real", "ly"]);
}

#[test]
fn speaker_or_language_change_starts_a_new_word() {
    let tokens = vec![
        spk(lang(tok("yes", 0, 100), "en"), "1"),
        spk(lang(tok("no", 100, 200), "en"), "2"), // no leading space, different speaker
        spk(lang(tok("oui", 200, 300), "fr"), "2"), // no leading space, different language
        spk(lang(tok("da", 300, 400), "fr"), "2"), // continues "oui"
    ];
    let t = tokens_to_transcript("a", "soniox", "m", false, &tokens);
    assert_eq!(texts(&t), ["yes", "no", "ouida"]);
    assert_eq!(t.speakers, ["1", "2"]);
    assert_eq!(t.languages, ["en", "fr"]);
    assert_eq!(t.words[1].speaker.as_deref(), Some("2"));
    assert_eq!(t.words[2].language.as_deref(), Some("fr"));
}

#[test]
fn punctuation_after_speaker_change_goes_to_the_next_word() {
    let tokens = vec![
        spk(tok("Okay", 0, 100), "1"),
        spk(tok(" \"", 150, 150), "2"),
        spk(tok("Fine", 150, 300), "2"),
        spk(tok(".\"", 300, 300), "2"),
    ];
    let t = tokens_to_transcript("a", "soniox", "m", false, &tokens);
    assert_eq!(texts(&t), ["Okay", "\"Fine.\""]);
    assert_eq!((t.words[1].token_start, t.words[1].token_end), (1, 4));
}

#[test]
fn opening_punctuation_prefixes_the_next_word() {
    let tokens = vec![
        tok(" ¿", 0, 0),
        tok("Qué", 0, 200),
        tok(" tal", 220, 400),
        tok("?", 400, 400),
        tok(" (", 500, 500),
    ];
    let t = tokens_to_transcript("a", "soniox", "m", false, &tokens);
    // a dangling opener with nothing after it stays with the last word
    assert_eq!(texts(&t), ["¿Qué", "tal?("]);
    assert_eq!(t.words[0].start, SourceTime::from_ms(0));
}

#[test]
fn scripts_without_spaces_get_one_word_per_token() {
    let tokens = vec![
        lang(tok("你", 0, 100), "zh"),
        lang(tok("好", 100, 200), "zh"),
        lang(tok("。", 200, 200), "zh"),
        lang(tok("世界", 300, 500), "zh"),
        lang(tok("สวัสดี", 600, 900), "th"),
    ];
    let t = tokens_to_transcript("a", "soniox", "m", false, &tokens);
    assert_eq!(texts(&t), ["你", "好。", "世界", "สวัสดี"]);
    assert_eq!(t.languages, ["zh", "th"]);
}

#[test]
fn word_times_are_monotonic_and_well_formed() {
    let tokens = vec![
        tok("one", 500, 600),
        tok(" two", 400, 450),   // starts before the previous word
        tok(" three", 700, 650), // ends before it starts
        tok(" four", -20, 10),   // negative start
    ];
    let t = tokens_to_transcript("a", "soniox", "m", false, &tokens);
    assert_eq!(t.words.len(), 4);
    for w in &t.words {
        assert!(w.end >= w.start, "{w:?}");
        assert!(w.start.0 >= 0);
    }
    for pair in t.words.windows(2) {
        assert!(pair[1].start >= pair[0].start, "{pair:?}");
    }
    assert_eq!(t.words[1].start, SourceTime::from_ms(500));
    assert_eq!(t.words[2].end, t.words[2].start);
}

#[test]
fn confidence_is_none_when_not_reported() {
    let mut a = tok("plain", 0, 100);
    a.confidence = None;
    let t = tokens_to_transcript("a", "soniox", "m", false, &[a]);
    assert_eq!(t.words[0].confidence, None);
    assert!(t.speakers.is_empty() && t.languages.is_empty());
}

#[test]
fn empty_input_gives_an_empty_transcript() {
    let t = tokens_to_transcript("a", "fixture", "m", true, &[]);
    assert!(t.words.is_empty() && t.tokens.is_empty());
    assert!(t.fixture);
}

#[test]
fn word_range_uses_normalised_words() {
    let tokens = vec![tok("a", 0, 100), tok(" b", 200, 300), tok(" c", 400, 500)];
    let t = tokens_to_transcript("a", "soniox", "m", false, &tokens);
    assert_eq!(
        t.word_range(SourceTime::from_ms(150), SourceTime::from_ms(350)),
        (1, 2)
    );
}

// ---------------------------------------------------------------------------------
// JSON bodies
// ---------------------------------------------------------------------------------

#[test]
fn parses_the_documented_transcript_example() {
    let body = r#"{
        "id": "19b6d61d-02db-4c25-bc71-b4094dc310c8",
        "text": "Hello",
        "tokens": [
            {"text": "Hel", "start_ms": 10, "end_ms": 90, "confidence": 0.95},
            {"text": "lo", "start_ms": 110, "end_ms": 160, "confidence": 0.98}
        ]
    }"#;
    let t: SonioxTranscript = serde_json::from_str(body).unwrap();
    assert_eq!(t.id, "19b6d61d-02db-4c25-bc71-b4094dc310c8");
    assert_eq!(t.text, "Hello");
    assert_eq!(t.tokens.len(), 2);
    assert_eq!(t.tokens[0].speaker, None);
    let transcript = tokens_to_transcript("asset", "soniox", DEFAULT_MODEL, false, &t.tokens);
    assert_eq!(texts(&transcript), ["Hello"]);
    assert_eq!(transcript.words[0].end, SourceTime::from_ms(160));
}

#[test]
fn token_fields_are_lenient() {
    let body = r#"{"tokens": [
        {"text": " a", "start_ms": 10, "end_ms": 90.6, "confidence": "0.5", "speaker": 1, "language": "en", "unknown_field": [1,2]},
        {"text": " b", "start_ms": "120", "end_ms": 200, "speaker": "2", "is_audio_event": false},
        {"text": " c", "start_ms": null, "end_ms": null, "speaker": null, "confidence": null},
        {"text": " d", "start_ms": 300, "end_ms": 400, "speaker": 3.0, "translation_status": "none"}
    ]}"#;
    let t: SonioxTranscript = serde_json::from_str(body).unwrap();
    assert_eq!(t.id, "");
    assert_eq!(t.tokens[0].speaker.as_deref(), Some("1"));
    assert_eq!(t.tokens[0].end_ms, Some(91));
    assert_eq!(t.tokens[0].confidence, Some(0.5));
    assert_eq!(t.tokens[1].start_ms, Some(120));
    assert_eq!(t.tokens[1].speaker.as_deref(), Some("2"));
    assert_eq!(t.tokens[2].start_ms, None);
    assert_eq!(t.tokens[3].speaker.as_deref(), Some("3"));
    let tr = tokens_to_transcript("a", "soniox", "m", false, &t.tokens);
    assert_eq!(texts(&tr), ["a", "b", "d"]);
    assert_eq!(tr.speakers, ["1", "2", "3"]);
}

const CREATE_EXAMPLE: &str = r#"{
    "id": "73d4357d-cad2-4338-a60d-ec6f2044f721",
    "status": "queued",
    "created_at": "2024-11-26T00:00:00Z",
    "model": "stt-async-preview",
    "audio_url": "https://soniox.com/media/examples/coffee_shop.mp3",
    "file_id": null,
    "filename": "coffee_shop.mp3",
    "language_hints": ["en", "fr"],
    "enable_speaker_diarization": false,
    "enable_language_identification": false,
    "audio_duration_ms": 0,
    "error_type": null,
    "error_message": null,
    "webhook_url": "https://example.com/webhook",
    "webhook_auth_header_name": "Authorization",
    "webhook_auth_header_value": "******************",
    "webhook_status_code": null,
    "client_reference_id": "some_internal_id"
}"#;

#[test]
fn parses_the_documented_transcription_example() {
    let t: SonioxTranscription = serde_json::from_str(CREATE_EXAMPLE).unwrap();
    assert_eq!(t.id, "73d4357d-cad2-4338-a60d-ec6f2044f721");
    assert_eq!(t.model, "stt-async-preview");
    assert_eq!(t.file_id, None);
    assert_eq!(t.filename.as_deref(), Some("coffee_shop.mp3"));
    assert_eq!(t.audio_duration_ms, Some(0));
    assert_eq!(t.client_reference_id.as_deref(), Some("some_internal_id"));
    assert_eq!(
        t.language_hints.as_deref(),
        Some(&["en".to_string(), "fr".to_string()][..])
    );
    assert_eq!(remote_status(&t), RemoteStatus::Queued);
}

#[test]
fn parses_file_objects() {
    let f: SonioxFile = serde_json::from_str(r#"{"id":"84c32fc6-4fb5-4e7a-b656-b5ec70493753","filename":"audio.flac","size":123456,"created_at":"2024-11-26T00:00:00Z","client_reference_id":null}"#).unwrap();
    assert_eq!(f.id, "84c32fc6-4fb5-4e7a-b656-b5ec70493753");
    assert_eq!(f.size, Some(123456));
    // missing fields default instead of failing
    let f: SonioxFile = serde_json::from_str("{}").unwrap();
    assert_eq!(f.id, "");
}

// ---------------------------------------------------------------------------------
// status normalisation
// ---------------------------------------------------------------------------------

fn transcription(status: &str) -> SonioxTranscription {
    SonioxTranscription {
        id: "t".into(),
        status: status.into(),
        ..Default::default()
    }
}

#[test]
fn remote_status_table() {
    assert_eq!(
        remote_status(&transcription("queued")),
        RemoteStatus::Queued
    );
    assert_eq!(
        remote_status(&transcription("processing")),
        RemoteStatus::Processing
    );
    assert_eq!(
        remote_status(&transcription("completed")),
        RemoteStatus::Completed
    );
    assert_eq!(
        remote_status(&transcription(" Completed ")),
        RemoteStatus::Completed
    );

    let mut failed = transcription("error");
    failed.error_type = Some("invalid_audio".into());
    failed.error_message = Some("Audio could not be decoded.".into());
    assert_eq!(
        remote_status(&failed),
        RemoteStatus::Error {
            error_type: Some("invalid_audio".into()),
            message: "Audio could not be decoded.".into()
        }
    );

    // an error without details still yields a message
    match remote_status(&transcription("error")) {
        RemoteStatus::Error {
            error_type: None,
            message,
        } => assert!(!message.is_empty()),
        other => panic!("{other:?}"),
    }
}

#[test]
fn unknown_status_is_an_error_not_endless_processing() {
    for s in ["paused", "", "COMPLETING", "done"] {
        match remote_status(&transcription(s)) {
            RemoteStatus::Error {
                error_type,
                message,
            } => {
                assert_eq!(error_type.as_deref(), Some("unknown_status"));
                assert!(message.contains("status"), "{message}");
            }
            other => panic!("status {s:?} normalised to {other:?}"),
        }
    }
}

#[test]
fn http_errors_are_classified() {
    use ProviderErrorKind as K;
    let body = r#"{"status_code":400,"error_type":"invalid_request","message":"Invalid request.","validation_errors":[{"error_type":"missing","location":"body.model","message":"Field required"}],"request_id":"req_1"}"#;
    let table: &[(u16, &str, K, bool)] = &[
        (400, body, K::InvalidRequest, false),
        (
            401,
            r#"{"status_code":401,"error_type":"unauthenticated","message":"Authentication error."}"#,
            K::Auth,
            false,
        ),
        (403, "", K::Auth, false),
        (
            402,
            r#"{"message":"Balance or budget exhausted."}"#,
            K::Payment,
            false,
        ),
        (
            404,
            r#"{"message":"Transcription not found."}"#,
            K::NotFound,
            false,
        ),
        (408, "", K::Timeout, true),
        (
            409,
            r#"{"message":"Invalid transcription state."}"#,
            K::Conflict,
            false,
        ),
        (413, "<html>too large</html>", K::InvalidRequest, false),
        (422, "{}", K::InvalidRequest, false),
        (
            429,
            r#"{"message":"Rate / capacity limit exceeded."}"#,
            K::RateLimited,
            true,
        ),
        (
            500,
            r#"{"message":"Internal server error."}"#,
            K::Server,
            true,
        ),
        (
            503,
            "<html><body>Service Unavailable</body></html>",
            K::Server,
            true,
        ),
        (418, "teapot", K::InvalidResponse, false),
    ];
    for (status, body, kind, retryable) in table {
        let e = classify_http_error(*status, body);
        assert_eq!(e.kind, *kind, "status {status}");
        assert_eq!(e.retryable, *retryable, "status {status}");
        assert_eq!(e.status, Some(*status));
        assert!(!e.message.is_empty());
        assert!(
            !e.message.contains('<'),
            "HTML leaked into message: {}",
            e.message
        );
        assert!(
            e.message.ends_with('.') || e.message.ends_with('…'),
            "not a sentence: {:?}",
            e.message
        );
    }
    let e = classify_http_error(400, body);
    assert!(e.message.contains("Invalid request"), "{}", e.message);
    assert!(
        e.message.contains("body.model: Field required"),
        "{}",
        e.message
    );
    let e = classify_http_error(401, "{}");
    assert!(e.message.contains("SONIOX_API_KEY"));
    let e = classify_http_error(418, "teapot");
    assert!(e.message.contains("HTTP 418") && e.message.contains("teapot"));
}

#[test]
fn error_messages_never_echo_credentials() {
    let e = classify_http_error(
        400,
        r#"{"message":"Bad header Authorization: Bearer sk-secret-123 supplied"}"#,
    );
    assert!(!e.message.contains("sk-secret-123"), "{}", e.message);
    let mut t = transcription("error");
    t.error_message = Some("token Bearer abc.def.ghi rejected".into());
    match remote_status(&t) {
        RemoteStatus::Error { message, .. } => assert!(!message.contains("abc.def.ghi")),
        other => panic!("{other:?}"),
    }
    assert!(ProviderError::not_configured()
        .message
        .contains("SONIOX_API_KEY"));
    assert!(ProviderError::not_configured()
        .message
        .contains("--fixture"));
}

#[test]
fn provider_job_failures_are_classified() {
    let e = transcription_failed(Some("invalid_audio_file"), "Audio could not be decoded.");
    assert_eq!(e.kind, ProviderErrorKind::Transcription);
    assert!(!e.retryable);
    assert!(e.message.contains("Audio could not be decoded"));
    assert!(transcription_failed(Some("file_not_found"), "gone")
        .retryable
        .eq(&false));
    assert!(transcription_failed(Some("unknown_status"), "weird")
        .retryable
        .eq(&false));
    assert!(transcription_failed(Some("internal_error"), "oops").retryable);
    assert!(transcription_failed(None, "").retryable);
    assert!(!transcription_failed(None, "").message.is_empty());
}

// ---------------------------------------------------------------------------------
// job state model
// ---------------------------------------------------------------------------------

#[test]
fn status_serialises_with_snake_case_states() {
    let st = TranscriptionStatus::queued("soniox", DEFAULT_MODEL, false, 1_000);
    let v = serde_json::to_value(&st).unwrap();
    assert_eq!(v["state"], "queued");
    assert_eq!(v["cleanup"], "not_needed");
    assert_eq!(v["model"], "stt-async-v5");
    for (state, name) in [
        (JobState::Uploading, "uploading"),
        (JobState::Processing, "processing"),
        (JobState::Completed, "completed"),
        (JobState::Failed, "failed"),
        (JobState::Cancelled, "cancelled"),
    ] {
        assert_eq!(serde_json::to_value(state).unwrap(), name);
    }
    assert_eq!(
        serde_json::to_value(ProviderErrorKind::RateLimited).unwrap(),
        "rate_limited"
    );
    let back: TranscriptionStatus = serde_json::from_value(v).unwrap();
    assert_eq!(back, st);
    // older / partial records still load
    let partial: TranscriptionStatus = serde_json::from_str(
        r#"{"state":"failed","provider":"soniox","model":"m","created_at_ms":1,"updated_at_ms":2}"#,
    )
    .unwrap();
    assert_eq!(partial.cleanup, CleanupState::NotNeeded);
    assert!(!partial.retryable);
}

#[test]
fn state_transitions() {
    let mut st = TranscriptionStatus::queued("soniox", DEFAULT_MODEL, false, 1);
    assert!(st.is_active() && st.can_cancel() && !st.can_retry() && !st.needs_cleanup());
    st.state = JobState::Uploading;
    assert!(st.is_active());
    st.file_id = Some("f".into());
    st.cleanup = CleanupState::Pending;
    st.state = JobState::Processing;
    st.transcription_id = Some("t".into());
    assert!(st.is_active() && st.has_remote_objects() && !st.needs_cleanup());

    // retryable failure
    let mut failed = st.clone();
    failed.fail(&classify_http_error(503, ""), 10);
    assert_eq!(failed.state, JobState::Failed);
    assert!(
        failed.retryable && failed.can_retry() && failed.is_terminal() && failed.needs_cleanup()
    );
    assert_eq!(failed.error_kind, Some(ProviderErrorKind::Server));
    assert_eq!(failed.updated_at_ms, 10);

    // permanent failure
    let mut denied = st.clone();
    denied.fail(&classify_http_error(401, ""), 11);
    assert!(!denied.retryable && denied.can_retry());

    // failing with a cancellation error is a cancellation
    let mut cancelled = st.clone();
    cancelled.fail(&ProviderError::cancelled(), 12);
    assert_eq!(cancelled.state, JobState::Cancelled);
    assert_eq!(cancelled.error_kind, Some(ProviderErrorKind::Cancelled));
    assert!(!cancelled.retryable);

    // completion, then cleanup bookkeeping
    st.complete(42, 20);
    assert_eq!(st.state, JobState::Completed);
    assert_eq!(st.word_count, Some(42));
    assert_eq!(st.message, None);
    assert!(st.needs_cleanup());
    let mut partial = st.clone();
    partial.record_cleanup(Some("f".into()), None, true, 21);
    assert_eq!(partial.cleanup, CleanupState::Failed);
    assert_eq!(partial.file_id.as_deref(), Some("f"));
    assert!(partial.needs_cleanup());
    st.record_cleanup(None, None, true, 22);
    assert_eq!(st.cleanup, CleanupState::Done);
    assert!(!st.has_remote_objects() && !st.needs_cleanup());

    let mut silent = TranscriptionStatus::queued("soniox", DEFAULT_MODEL, false, 1);
    silent.complete(0, 2);
    assert!(silent.message.as_deref().unwrap().contains("No speech"));
}

#[test]
fn start_rules() {
    assert!(can_start(&None, false));
    let mut st = TranscriptionStatus::queued("soniox", DEFAULT_MODEL, false, 1);
    for state in [JobState::Queued, JobState::Uploading, JobState::Processing] {
        st.state = state;
        assert!(!can_start(&Some(st.clone()), false));
        assert!(
            !can_start(&Some(st.clone()), true),
            "an active job is never duplicated"
        );
    }
    st.state = JobState::Completed;
    assert!(!can_start(&Some(st.clone()), false));
    assert!(can_start(&Some(st.clone()), true));
    for state in [JobState::Failed, JobState::Cancelled] {
        st.state = state;
        assert!(can_start(&Some(st.clone()), false));
    }
}

// ---------------------------------------------------------------------------------
// fixture tokens
// ---------------------------------------------------------------------------------

#[test]
fn fixture_tokens_are_deterministic_and_bounded() {
    let a = fixture_tokens(60_000, "asset-1");
    let b = fixture_tokens(60_000, "asset-1");
    assert_eq!(a, b);
    assert!(!a.is_empty());
    let mut last_start = 0;
    for t in &a {
        let (s, e) = (t.start_ms.unwrap(), t.end_ms.unwrap());
        assert!(s >= 0 && e >= s && e <= 60_000, "{t:?}");
        assert!(s >= last_start, "token starts must not go backwards");
        last_start = s;
        assert_eq!(t.language.as_deref(), Some("en"));
        assert!(matches!(t.speaker.as_deref(), Some("1") | Some("2")));
        let c = t.confidence.unwrap();
        assert!((0.0..=1.0).contains(&c));
    }
    // a different seed changes details but not the script
    let c = fixture_tokens(60_000, "asset-2");
    assert_ne!(a, c);
    let words = |toks: &[SonioxToken]| {
        tokens_to_transcript("x", "fixture", "fixture-stt", true, toks)
            .words
            .iter()
            .map(|w| w.text.clone())
            .collect::<Vec<_>>()
    };
    let (wa, wc) = (words(&a), words(&c));
    let n = wa.len().min(wc.len()).min(40);
    assert_eq!(wa[..n], wc[..n]);
}

#[test]
fn fixture_tokens_look_like_labelled_soniox_output() {
    let tokens = fixture_tokens(90_000, "seed");
    let t = tokens_to_transcript("asset", "fixture", "fixture-stt", true, &tokens);
    let text = t
        .words
        .iter()
        .map(|w| w.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        text.starts_with("This is fixture speech for testing the editor."),
        "{text}"
    );
    assert!(t.fixture);
    assert_eq!(t.speakers, ["1", "2"]);
    assert_eq!(t.languages, ["en"]);
    // sub-word pieces and separate punctuation tokens, like the real API
    assert!(tokens.len() > t.words.len());
    assert!(tokens.iter().any(|k| k.text == "," || k.text == "."));
    assert!(tokens
        .iter()
        .skip(1)
        .any(|k| !k.text.starts_with(' ') && k.text.chars().all(char::is_alphabetic)));
    // filler words, low-confidence words and long pauses exist for the review tools
    let fillers = t
        .words
        .iter()
        .filter(|w| cutline_core::analysis::is_filler(&w.text))
        .count();
    assert!(fillers >= 4, "only {fillers} fillers");
    assert!(t.words.iter().any(|w| w.confidence.unwrap() < 0.65));
    assert!(t.words.iter().any(|w| w.confidence.unwrap() > 0.9));
    let long_pauses = t
        .words
        .windows(2)
        .filter(|p| p[1].start - p[0].end > SourceTime::from_ms(1000).0)
        .count();
    assert!(long_pauses >= 2, "only {long_pauses} long pauses");
    // natural pace
    let rate = t.words.len() as f64 / 90.0;
    assert!((1.5..=3.5).contains(&rate), "{rate} words/s");
    // speech reaches towards the end of the media
    assert!(t.words.last().unwrap().end > SourceTime::from_ms(80_000));
}

#[test]
fn fixture_tokens_handle_tiny_durations() {
    assert!(fixture_tokens(0, "s").is_empty());
    assert!(fixture_tokens(-5, "s").is_empty());
    assert!(fixture_tokens(350, "s").is_empty());
    let short = fixture_tokens(3_000, "s");
    assert!(!short.is_empty());
    assert!(short.iter().all(|t| t.end_ms.unwrap() <= 3_000));
    // tokens survive a JSON round trip unchanged
    let json = serde_json::to_string(&short).unwrap();
    let back: Vec<SonioxToken> = serde_json::from_str(&json).unwrap();
    assert_eq!(back, short);
}
