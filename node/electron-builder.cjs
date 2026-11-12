module.exports = {
  appId: 'com.shroom.synapse-acquisition',
  productName: 'Shroom Capture',
  electronDist: 'node_modules/electron/dist',
  directories: { output: 'release/electron' },
  files: ['electron/**/*', 'src/**/*', 'ui/dist/**/*', 'package.json', '!**/.env*'],
  // The SDK uses Node-API prebuilts; keep the service, workers and native modules on disk.
  asar: true,
  asarUnpack: ['src/**/*', 'electron/backend.mjs', 'electron/integration-worker.mjs', 'node_modules/**/*'],
  npmRebuild: false,
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'electron/assets/icon.ico' },
  nsis: {
    oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true, shortcutName: 'Shroom 数采工作站',
    deleteAppDataOnUninstall: false,
    artifactName: 'Shroom-Capture-${version}-${arch}-Setup.${ext}',
  },
};
