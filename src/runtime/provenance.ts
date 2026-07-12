/** Build/runtime provenance exposed in diagnostics and workflow artifacts. */

declare const __BP_PACKAGE_VERSION__: string | undefined;
declare const __BP_GIT_SOURCE_HASH__: string | undefined;
declare const __BP_BUILD_HASH__: string | undefined;

export interface BuildProvenance {
  packageVersion: string;
  gitSourceHash: string;
  buildHash: string;
}

export function getBuildProvenance(): BuildProvenance {
  return {
    packageVersion:
      typeof __BP_PACKAGE_VERSION__ === 'string' ? __BP_PACKAGE_VERSION__ : '0.0.1-dev',
    gitSourceHash: typeof __BP_GIT_SOURCE_HASH__ === 'string' ? __BP_GIT_SOURCE_HASH__ : 'unknown',
    buildHash: typeof __BP_BUILD_HASH__ === 'string' ? __BP_BUILD_HASH__ : 'development',
  };
}
