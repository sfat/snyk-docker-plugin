import * as Debug from "debug";
import * as path from "path";
import * as analyzer from "./analyzer";
import { Docker, DockerOptions } from "./docker";
import * as dockerFile from "./docker-file";
import { getRuntime } from "./inputs/runtime/docker";
import { buildResponse } from "./response-builder";
import { StaticAnalysisOptions } from "./types";

export { inspect, dockerFile };

const debug = Debug("snyk");

const MAX_MANIFEST_FILES = 5;

function inspect(root: string, targetFile?: string, options?: any) {
  const targetImage = root;

  if (isRequestingStaticAnalysis(options)) {
    return analyzeStatically(targetImage, options);
  }

  return dockerFile
    .readDockerfileAndAnalyse(targetFile)
    .then((dockerfileAnalysis) => {
      return analyzeDynamically(
        targetImage,
        dockerfileAnalysis,
        getDynamicAnalysisOptions(options),
      );
    });
}

function analyzeDynamically(
  targetImage: string,
  dockerfileAnalysis: dockerFile.DockerFileAnalysis | undefined,
  analysisOptions: any,
) {
  return Promise.all([
    getRuntime(analysisOptions),
    getDependencies(targetImage, dockerfileAnalysis, analysisOptions),
    getManifestFiles(targetImage, analysisOptions),
  ]).then((res) => {
    return buildResponse(
      res[0],
      res[1],
      dockerfileAnalysis,
      res[2],
      analysisOptions,
    );
  });
}

async function analyzeStatically(targetImage: string, options: any) {
  const staticAnalysisOptions = getStaticAnalysisOptions(options);

  // Relevant only if using a Docker runtime. Optional, but we may consider what to put here
  // to present to the user in Snyk UI.
  const runtime = undefined;
  // Both the analysis and the manifest files are relevant if inspecting a Dockerfile.
  // This is not the case for static scanning.
  const dockerfileAnalysis = undefined;
  const manifestFiles = [];

  try {
    const staticAnalysis = await analyzer.analyzeStatically(
      targetImage,
      staticAnalysisOptions,
    );

    const parsedAnalysisResult = parseAnalysisResults(
      targetImage,
      staticAnalysis,
      dockerfileAnalysis,
    );

    const dependenciesTree = await buildTree(
      targetImage,
      parsedAnalysisResult.type,
      parsedAnalysisResult.depInfosList,
      parsedAnalysisResult.targetOS,
    );

    const analysis = {
      package: dependenciesTree,
      packageManager: parsedAnalysisResult.type,
      imageId: parsedAnalysisResult.imageId,
      binaries: parsedAnalysisResult.binaries,
      imageLayers: parsedAnalysisResult.imageLayers,
    };

    return buildResponse(
      runtime,
      analysis,
      dockerfileAnalysis,
      manifestFiles,
      staticAnalysisOptions,
    );
  } catch (error) {
    const analysisError = tryGetAnalysisError(error, targetImage);
    throw analysisError;
  }
}

function tryGetAnalysisError(error, targetImage): Error {
  if (typeof error === "string") {
    debug(`Error while running analyzer: '${error}'`);
    handleCommonErrors(error, targetImage);
    let errorMsg = error;
    const errorMatch = /msg="(.*)"/g.exec(errorMsg);
    if (errorMatch) {
      errorMsg = errorMatch[1];
    }
    return new Error(errorMsg);
  }

  return error;
}

function isRequestingStaticAnalysis(options?: any): boolean {
  return options && options.staticAnalysisOptions;
}

function getStaticAnalysisOptions(options: any): StaticAnalysisOptions {
  if (
    !options ||
    !options.staticAnalysisOptions ||
    !options.staticAnalysisOptions.imagePath ||
    options.staticAnalysisOptions.imageType === undefined
  ) {
    throw new Error("Missing required parameters for static analysis");
  }

  return {
    imagePath: options.staticAnalysisOptions.imagePath,
    imageType: options.staticAnalysisOptions.imageType,
    tmpDirPath: options.staticAnalysisOptions.tmpDirPath,
  };
}

// TODO: return type should be "DynamicAnalysisOptions" or something that extends DockerOptions
function getDynamicAnalysisOptions(options?: any): any {
  return options
    ? {
        host: options.host,
        tlsverify: options.tlsverify,
        tlscert: options.tlscert,
        tlscacert: options.tlscacert,
        tlskey: options.tlskey,
        manifestGlobs: options.manifestGlobs,
        manifestExcludeGlobs: options.manifestExcludeGlobs,
      }
    : {};
}

function handleCommonErrors(error, targetImage: string) {
  if (error.indexOf("command not found") !== -1) {
    throw new Error("Snyk docker CLI was not found");
  }
  if (error.indexOf("Cannot connect to the Docker daemon") !== -1) {
    throw new Error(
      "Cannot connect to the Docker daemon. Is the docker" + " daemon running?",
    );
  }
  const ERROR_LOADING_IMAGE_STR = "Error loading image from docker engine:";
  if (error.indexOf(ERROR_LOADING_IMAGE_STR) !== -1) {
    if (error.indexOf("reference does not exist") !== -1) {
      throw new Error(`Docker image was not found locally: ${targetImage}`);
    }
    if (error.indexOf("permission denied while trying to connect") !== -1) {
      let errString = error.split(ERROR_LOADING_IMAGE_STR)[1];
      errString = (errString || "").slice(0, -2); // remove trailing \"
      throw new Error(
        "Permission denied connecting to docker daemon. " +
          "Please make sure user has the required permissions. " +
          "Error string: " +
          errString,
      );
    }
  }
  if (error.indexOf("Error getting docker client:") !== -1) {
    throw new Error("Failed getting docker client");
  }
  if (error.indexOf("Error processing image:") !== -1) {
    throw new Error("Failed processing image:" + targetImage);
  }
}

function getDependencies(
  targetImage: string,
  dockerfileAnalysis?: dockerFile.DockerFileAnalysis,
  options?: DockerOptions,
) {
  let result;
  return analyzer
    .analyzeDynamically(targetImage, dockerfileAnalysis, options)
    .then((output) => {
      result = parseAnalysisResults(targetImage, output, dockerfileAnalysis);
      return buildTree(
        targetImage,
        result.type,
        result.depInfosList,
        result.targetOS,
      );
    })
    .then((pkg) => {
      return {
        package: pkg,
        packageManager: result.type,
        imageId: result.imageId,
        binaries: result.binaries,
        imageLayers: result.imageLayers,
      };
    })
    .catch((error) => {
      const analysisError = tryGetAnalysisError(error, targetImage);
      throw analysisError;
    });
}

async function getManifestFiles(targetImage: string, options?: any) {
  if (!options.manifestGlobs) {
    return [];
  }

  let excludeGlobs: string[] = [];
  if (options.manifestExcludeGlobs) {
    excludeGlobs = options.manifestExcludeGlobs as string[];
  }

  const globs = options.manifestGlobs as string[];
  const docker = new Docker(targetImage, options);

  let files = await docker.findGlobs(globs, excludeGlobs);

  // Limit the number of manifest files which we return
  // to avoid overwhelming the docker daemon with cat requests

  if (files.length > MAX_MANIFEST_FILES) {
    files = files.slice(0, MAX_MANIFEST_FILES);
  }

  const contents = await Promise.all(files.map((f) => docker.catSafe(f)));

  return files
    .map((g, i) => {
      return {
        name: path.basename(g),
        path: path.dirname(g),
        contents: Buffer.from(contents[i].stdout).toString("base64"),
      };
    })
    .filter((i) => i.contents !== "");
}

function parseAnalysisResults(
  targetImage,
  analysisJson,
  dockerfileAnalysis?: dockerFile.DockerFileAnalysis,
) {
  let analysisResult = analysisJson.results.filter((res) => {
    return res.Analysis && res.Analysis.length > 0;
  })[0];

  if (!analysisResult) {
    if (dockerfileAnalysis && dockerfileAnalysis.baseImage === "scratch") {
      // Special case when we have no package management
      // on scratch images

      analysisResult = {
        Image: targetImage,
        AnalyzeType: "linux",
        Analysis: [],
      };
    } else {
      throw new Error(
        "Failed to detect a supported Linux package manager (deb/rpm/apk)",
      );
    }
  }

  let depType;
  switch (analysisResult.AnalyzeType) {
    case "Apt": {
      depType = "deb";
      break;
    }
    default: {
      depType = analysisResult.AnalyzeType.toLowerCase();
    }
  }

  return {
    imageId: analysisJson.imageId,
    targetOS: analysisJson.osRelease,
    type: depType,
    depInfosList: analysisResult.Analysis,
    binaries: analysisJson.binaries.Analysis,
    imageLayers: analysisJson.imageLayers,
  };
}

function buildTree(targetImage, depType, depInfosList, targetOS) {
  // A tag can only occur in the last section of a docker image name, so
  // check any colon separator after the final '/'. If there are no '/',
  // which is common when using Docker's official images such as
  // "debian:stretch", just check for ':'
  const finalSlash = targetImage.lastIndexOf("/");
  const hasVersion =
    (finalSlash >= 0 && targetImage.slice(finalSlash).includes(":")) ||
    targetImage.includes(":");

  // Defaults for simple images from dockerhub, like "node" or "centos"
  let imageName = targetImage;
  let imageVersion = "latest";

  // If we have a version, split on the last ':' to avoid the optional
  // port on a hostname (i.e. localhost:5000)
  if (hasVersion) {
    const versionSeparator = targetImage.lastIndexOf(":");
    imageName = targetImage.slice(0, versionSeparator);
    imageVersion = targetImage.slice(versionSeparator + 1);
  }

  const shaString = "@sha256";

  if (imageName.endsWith(shaString)) {
    imageName = imageName.slice(0, imageName.length - shaString.length);
    imageVersion = "";
  }

  const root = {
    // don't use the real image name to avoid scanning it as an issue
    name: "docker-image|" + imageName,
    version: imageVersion,
    targetOS,
    packageFormatVersion: depType + ":0.0.1",
    dependencies: {},
  };

  const depsMap = depInfosList.reduce((acc, depInfo) => {
    const name = depInfo.Name;
    acc[name] = depInfo;
    return acc;
  }, {});

  const virtualDepsMap = depInfosList.reduce((acc, depInfo) => {
    const providesNames = depInfo.Provides || [];
    providesNames.forEach((name) => {
      acc[name] = depInfo;
    });
    return acc;
  }, {});

  const depsCounts = {};
  depInfosList.forEach((depInfo) => {
    countDepsRecursive(
      depInfo.Name,
      new Set(),
      depsMap,
      virtualDepsMap,
      depsCounts,
    );
  });
  const DEP_FREQ_THRESHOLD = 100;
  const tooFrequentDepNames = Object.keys(depsCounts).filter((depName) => {
    return depsCounts[depName] > DEP_FREQ_THRESHOLD;
  });

  const attachDeps = (depInfos) => {
    const depNamesToSkip = new Set(tooFrequentDepNames);
    depInfos.forEach((depInfo) => {
      const subtree = buildTreeRecurisve(
        depInfo.Name,
        new Set(),
        depsMap,
        virtualDepsMap,
        depNamesToSkip,
      );
      if (subtree) {
        root.dependencies[subtree.name] = subtree;
      }
    });
  };

  // attach (as direct deps) pkgs not marked auto-installed:
  const manuallyInstalledDeps = depInfosList.filter((depInfo) => {
    return !depInfo.AutoInstalled;
  });
  attachDeps(manuallyInstalledDeps);

  // attach (as direct deps) pkgs marked as auto-insatalled,
  //  but not dependant upon:
  const notVisitedDeps = depInfosList.filter((depInfo) => {
    const depName = depInfo.Name;
    return !depsMap[depName]._visited;
  });
  attachDeps(notVisitedDeps);

  // group all the "too frequest" deps under a meta package:
  if (tooFrequentDepNames.length > 0) {
    const tooFrequentDeps = tooFrequentDepNames.map((name) => {
      return depsMap[name];
    });

    const metaSubtree = {
      name: "meta-common-packages",
      version: "meta",
      dependencies: {},
    };

    tooFrequentDeps.forEach((depInfo) => {
      const pkg = {
        name: depFullName(depInfo),
        version: depInfo.Version,
      };
      metaSubtree.dependencies[pkg.name] = pkg;
    });

    root.dependencies[metaSubtree.name] = metaSubtree;
  }

  return root;
}

function buildTreeRecurisve(
  depName,
  ancestors,
  depsMap,
  virtualDepsMap,
  depNamesToSkip,
) {
  const depInfo = depsMap[depName] || virtualDepsMap[depName];
  if (!depInfo) {
    return null;
  }

  // "realName" as the argument depName might be a virtual pkg
  const realName = depInfo.Name;
  const fullName = depFullName(depInfo);
  if (ancestors.has(fullName) || depNamesToSkip.has(realName)) {
    return null;
  }

  const tree: {
    name: string;
    version: string;
    dependencies?: any;
  } = {
    name: fullName,
    version: depInfo.Version,
  };
  if (depInfo._visited) {
    return tree;
  }
  depInfo._visited = true;

  const newAncestors = new Set(ancestors).add(fullName);

  const deps = depInfo.Deps || {};
  Object.keys(deps).forEach((name) => {
    const subTree = buildTreeRecurisve(
      name,
      newAncestors,
      depsMap,
      virtualDepsMap,
      depNamesToSkip,
    );
    if (subTree) {
      if (!tree.dependencies) {
        tree.dependencies = {};
      }
      if (!tree.dependencies[subTree.name]) {
        tree.dependencies[subTree.name] = subTree;
      }
    }
  });

  return tree;
}

function countDepsRecursive(
  depName,
  ancestors,
  depsMap,
  virtualDepsMap,
  depCounts,
) {
  const depInfo = depsMap[depName] || virtualDepsMap[depName];
  if (!depInfo) {
    return;
  }

  // "realName" as the argument depName might be a virtual pkg
  const realName = depInfo.Name;
  if (ancestors.has(realName)) {
    return;
  }

  depCounts[realName] = (depCounts[realName] || 0) + 1;

  const newAncestors = new Set(ancestors).add(realName);
  const deps = depInfo.Deps || {};
  Object.keys(deps).forEach((name) => {
    countDepsRecursive(name, newAncestors, depsMap, virtualDepsMap, depCounts);
  });
}

function depFullName(depInfo) {
  let fullName = depInfo.Name;
  if (depInfo.Source) {
    fullName = depInfo.Source + "/" + fullName;
  }
  return fullName;
}
