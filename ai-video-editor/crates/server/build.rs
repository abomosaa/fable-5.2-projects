// The web UI is embedded into the binary; rebuild whenever anything under `web/`
// changes (including added or removed files) so the embedded copy is never stale.
fn main() {
    println!("cargo:rerun-if-changed=../../web");
    println!("cargo:rerun-if-changed=build.rs");
}
