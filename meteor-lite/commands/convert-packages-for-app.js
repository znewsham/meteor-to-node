import fs from 'fs-extra';
import path from 'path';

import { baseFolder, generateGlobals } from './helpers/command-helpers.js';
import ConversionJob from '../conversion/conversion-job.js';
import { meteorNameToNodeName, meteorNameToNodePackageDir } from '../helpers/helpers.js';
import { getFinalPackageListForArch } from './helpers/final-package-list';
import MeteorPackage, { TestSuffix } from '../conversion/meteor-package.js';
import writePeerDependencies from './write-peer-dependencies.js';
import { ExcludePackageNames } from '../constants.js';
import dependencyEntry from './helpers/dependency-entry.js';

// TODO: arch we shouldn't enforce that client lives in the client folder.
// TODO: this is a mess, the combo of lazy, production and conditional (per-arch) exports
export async function updateDependenciesForArch(nodePackagesVersionsAndExports, clientOrServer) {
  const { map, conditionalMap } = generateGlobals(nodePackagesVersionsAndExports, clientOrServer);

  const importsToWrite = [];
  const globalsToWrite = [];
  nodePackagesVersionsAndExports.forEach(({ nodeName, isLazy, onlyLoadIfProd }, i) => {
    const { importToWrite, globalToWrite } = dependencyEntry({
      nodeName,
      isLazy,
      onlyLoadIfProd,
      globalsMap: map,
      conditionalMap,
      importSuffix: i,
    });
    if (importToWrite) {
      importsToWrite.push(importToWrite);
    }
    if (globalToWrite) {
      globalsToWrite.push(globalToWrite);
    }
  });
  await fs.writeFile(`./${clientOrServer}/dependencies.js`, [...importsToWrite, ...globalsToWrite].filter(Boolean).join('\n'));
}

export default async function convertPackagesToNodeModulesForApp({
  extraPackages = [],
  outputDirectory: outputGeneralDirectory,
  directories: otherPackageFolders = [],
  outputSharedDirectory,
  outputLocalDirectory,
  updateDependencies,
  meteorInstall,
  forceRefresh,
  appPackagesOverride,
}) {
  // by using versions instead of packages we'll enforce converting the exact versions of every package
  // but it also means we're gonna look at every package - not just "ours" + lazily their dependencies
  let appPackages = appPackagesOverride || (await fs.readFile(`${baseFolder}/packages`))
    .toString()
    .split('\n')
    .map((line) => line.split('#')[0].trim().split('@')[0])
    .filter(Boolean);

  const appVersions = (await fs.readFile(`${baseFolder}/versions`))
    .toString()
    .split('\n')
    .map((line) => line.split('#')[0].trim())
    .filter(Boolean);

  const options = {
    forceRefresh,
    skipNonLocalIfPossible: true,
    // TODO: this assumes ./packages and ./.common are first - we should instead make this an option
    localPackageFolders: otherPackageFolders.slice(0, 2),
  };

  const job = new ConversionJob({
    outputGeneralDirectory,
    outputSharedDirectory,
    outputLocalDirectory,
    otherPackageFolders,
    meteorInstall,
    options,
    checkVesions: true,
  });

  const outputFolderMapping = {
    [MeteorPackage.Types.ISO]: outputGeneralDirectory,
    [MeteorPackage.Types.OTHER]: outputGeneralDirectory,
    [MeteorPackage.Types.LOCAL]: outputLocalDirectory || outputGeneralDirectory,
    [MeteorPackage.Types.SHARED]: outputSharedDirectory || outputGeneralDirectory,
  };

  const allPackages = Array.from(new Set([
    ...appPackages,
    ...extraPackages,
  ])).filter((name) => !ExcludePackageNames.has(name));

  await job.convertPackages(allPackages, appVersions);

  // HACK: we pass in a test suffix necessary to get the conversion job to convert specific packages tests
  // but when we get here we need to be working with clean names - it's possible we can handle this as part of the meteorNameToNodeName functions
  appPackages = appPackages.map((meteorName) => meteorName.endsWith(TestSuffix) ? meteorName.replace(TestSuffix, '') : meteorName);

  const actualPackages = appPackages
    .map((nameAndMaybeVersion) => nameAndMaybeVersion.split('@')[0])
    .filter((name) => job.has(name));
  const packageJsonEntries = Object.fromEntries(await Promise.all(actualPackages.map(async (meteorName) => {
    const outputDirectory = job.get(meteorName).outputParentFolder(outputFolderMapping);
    const folderPath = path.join(outputDirectory, meteorNameToNodePackageDir(meteorName));
    return [
      meteorNameToNodeName(meteorName),
      await fs.pathExists(folderPath) ? `file:${folderPath}` : job.get(meteorName).version,
    ];
  })));

  const packageJson = JSON.parse((await fs.readFile('./package.json')).toString());
  packageJson.dependencies = Object.fromEntries(Object.entries({
    ...packageJson.dependencies,
    ...packageJsonEntries,
  }).sort(([a], [b]) => a.localeCompare(b)));

  await fs.writeFile('./package.json', JSON.stringify(packageJson, null, 2));
  if (updateDependencies) {
    await writePeerDependencies({ name: 'meteor-peer-dependencies' });
    const nodePackagesAndVersions = actualPackages.map((meteorName) => {
      const nodeName = meteorNameToNodeName(meteorName);
      const { version } = job.get(meteorName);
      return {
        nodeName,
        version,
      };
    });
    const [serverPackages, clientPackages] = await Promise.all([
      getFinalPackageListForArch(nodePackagesAndVersions, 'server'),
      getFinalPackageListForArch(nodePackagesAndVersions, 'client'),
    ]);
    await Promise.all([
      updateDependenciesForArch(serverPackages, 'server'),
      updateDependenciesForArch(clientPackages, 'client'),
    ]);
  }
  return job;
}
