const { getDefaultConfig } = require('expo/metro-config');
const config = getDefaultConfig(__dirname);
config.resolver.blockList = [/\/native\/(?:[^/]+\/)?target\/.*$/, /\/artifacts\/.*$/];
module.exports = config;
