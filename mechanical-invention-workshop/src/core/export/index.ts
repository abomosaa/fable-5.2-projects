/**
 * Manufacturing export: meshes (STL, 3MF), drawings (SVG), cutting profiles
 * (DXF, SVG), bill of materials (CSV) and the assembly guide (HTML).
 *
 * `initKernel()` from core/geom/kernel must have resolved before any function
 * that builds solids is called (STL / 3MF export and checkPrintable).
 */
export { meshToBinarySTL, parseBinarySTL, type ParsedSTL } from './stl';
export { meshesTo3MF, parse3MF, f32str, type ThreeMFItem, type Parsed3MF, type Parsed3MFObject } from './threemf';
export {
  checkPrintable, reportForMesh, thinFeatureLoss, COMMON_BED, HUMAN_VALIDATION_NOTE,
  type PrintIssue, type PrintReport, type ThinFeatureResult,
} from './printcheck';
export { partNumber, partFileBase, buildExportMesh, stlFromReport, exportPartSTL, exportParts3MF } from './parts';
export { partDrawingSVG, scaleLabel, GENERAL_NOTE, SHEET_W, SHEET_H } from './drawing';
export { partProfileDXF, partProfileSVG, profileData, type ProfileData, type ProfileLayer } from './profile';
export {
  buildBOM, bomCSV, beltLength, beltInfo, springInfo, pinSpec, motorDriveSpec, jointHardware, jointActive, activeJoints,
  BOM_CSV_COLUMNS, type BomRow, type JointHardware, type BeltInfo, type SpringInfo,
} from './bom';
export {
  assemblyGuideHTML, explodedViewSVG, assemblySteps, jointKeyParameter, simplifyClosed, GUIDE_DISCLAIMER,
  type ExplodedOpts, type AssemblyStep,
} from './guide';
export { sanitizeName, identityKey, identicalCount, geometryBounds, partMesh, restOnZ0 } from './common';
