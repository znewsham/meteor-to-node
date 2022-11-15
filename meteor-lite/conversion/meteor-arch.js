import path from 'path';
import { getImportTreeForPackageAndClean } from './globals.js';

export default class MeteorArch {
  #archName;

  #parentArch;

  #childArchs = new Set();

  #exports = [];

  #imports = new Map();

  #impliedPackages = new Set();

  #preloadPackages = new Set();

  #unorderedPackages = new Set();

  #mainModule;

  #assets = [];

  #modified = false;

  constructor(archName, parentArch) {
    this.#archName = archName;
    this.#parentArch = parentArch;
    if (parentArch) {
      parentArch.#childArchs.add(this);
    }
  }

  addExport(symbol) {
    this.#exports.push(symbol);
    this.#modified = true;
  }

  addAsset(file) {
    this.#assets.push(file);
    this.#modified = true;
  }

  addImport(item, importOrder) {
    this.#imports.set(item, importOrder);
    this.#modified = true;
  }

  addPreloadPackage(nodeName) {
    this.#preloadPackages.add(nodeName);
    this.#modified = true;
  }

  addUnorderedPackage(nodeName) {
    this.#unorderedPackages.add(nodeName);
    this.#modified = true;
  }

  addImpliedPackage(meteorName) {
    this.#impliedPackages.add(meteorName);
    this.#modified = true;
  }

  setMainModule(filePath) {
    this.#mainModule = filePath;
    this.#modified = true;
  }

  getPreloadPackages(justOwn = false) {
    if (justOwn) {
      return this.#preloadPackages;
    }
    return new Set([...this.#parentArch?.getPreloadPackages() || [], ...this.#preloadPackages]);
  }

  #getImportsEntries() {
    return [
      ...Array.from(this.#imports.entries()),
      ...(this.#parentArch ? Array.from(this.#parentArch.#getImportsEntries()) : []),
    ];
  }

  getImports(justOwn = false) {
    if (justOwn) {
      return new Set(this.#imports.keys());
    }
    const all = this.#getImportsEntries();

    all.sort((a, b) => a[1] - b[1]);

    return new Set(all.map(([imp]) => imp));
  }

  getMainModule(justOwn = false) {
    if (justOwn) {
      return this.#mainModule;
    }
    return this.#mainModule || this.#parentArch?.getMainModule();
  }

  getExports(justOwn = false) {
    if (justOwn) {
      return this.#exports;
    }
    return Array.from(new Set([...this.#parentArch?.getExports() || [], ...this.#exports]));
  }

  getAssets(justOwn = false) {
    if (justOwn) {
      return this.#assets;
    }
    return [...this.#parentArch?.getAssets() || [], ...this.#assets];
  }

  getImpliedPackages(justOwn = false) {
    if (justOwn) {
      return this.#impliedPackages;
    }
    return new Set([...this.#parentArch?.getImpliedPackages() || [], ...this.#impliedPackages]);
  }

  get archName() {
    return this.#archName;
  }

  get parentArch() {
    return this.#parentArch;
  }

  async getImportTreeForPackageAndClean(
    outputFolder,
    archsForFiles,
    isCommon,
    exportedMap,
  ) {
    return getImportTreeForPackageAndClean(
      outputFolder,
      [
        ...(this.getMainModule() ? [path.join(outputFolder, this.getMainModule())] : []),
        ...Array.from(this.getImports())
          .filter((file) => file.startsWith('.'))
          .filter((file) => file.endsWith('.js'))
          .map((file) => path.join(outputFolder, file)),
      ],
      this.#archName,
      archsForFiles,
      isCommon,
      exportedMap,
    );
  }

  hasChildArchs() {
    return this.#childArchs.size !== 0;
  }

  isNoop(justOwn = true) {
    if (!justOwn) {
      return !this.#modified && this.parentArch?.isNoop();
    }
    return !this.#modified;
  }

  getExportArchName() {
    if (this.#archName === 'server') {
      return 'node';
    }
    return this.#archName;
  }

  getActiveArch() {
    if (!this.isNoop() || !this.#parentArch) {
      return this;
    }
    return this.#parentArch.getActiveArch();
  }
}
