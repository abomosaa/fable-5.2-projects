/**
 * The instant at which the fixture/demo world starts. All bundled fixtures were captured or authored
 * before this moment; snapshot-type fixtures (positions, current conditions) are timed to the minutes before it.
 */
export const FIXTURE_EPOCH_ISO = '2026-11-11T00:00:00Z';
export const FIXTURE_EPOCH = Date.parse(FIXTURE_EPOCH_ISO);
