/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

var DEFAULT_START_PORT = 8008;
var DEFAULT_END_PORT = 8018;
var DEFAULT_TIMEOUT = 10 * 60 * 1000; // 10 minutes in msec - this will become a param

function ParamedicConfig(json) {
    this._config = json;
}

ParamedicConfig.parseFromArguments = function (argv) {
    return new ParamedicConfig({
        platform:          argv.platform,
        action:            !!argv.justbuild ? 'build' : 'run',
        args:              (!!argv.browserify ? '--browserify ' : '') + (!!argv.device ? '--device' : ''),
        plugins:           Array.isArray(argv.plugin) ? argv.plugin : [argv.plugin],
        useTunnel:         !!argv.useTunnel,
        verbose:           !!argv.verbose,
        startPort:         argv.startport || argv.port,
        endPort:           argv.endport || argv.port,
        externalServerUrl: argv.externalServerUrl,
        reportSavePath:    !!argv.reportSavePath? argv.reportSavePath: undefined,
        cleanUpAfterRun:   !!argv.cleanUpAfterRun? true: false,
        shouldUseSauce:    !!argv.shouldUseSauce || false
    });
};

ParamedicConfig.parseFromFile = function (paramedicConfigPath) {
    return new ParamedicConfig(require(paramedicConfigPath));
};

ParamedicConfig.prototype.getUseTunnel = function () {
    return this._config.useTunnel;
};

ParamedicConfig.prototype.getReportSavePath = function () {
    return this._config.reportSavePath;
};

ParamedicConfig.prototype.getShouldCleanUpAfterRun = function () {
    return this._config.cleanUpAfterRun;
};

ParamedicConfig.prototype.getPlatform = function() {
    return this._config.platform;
};

ParamedicConfig.prototype.getAction = function() {
    return this._config.action;
};

ParamedicConfig.prototype.getArgs = function() {
    return this._config.args;
};

ParamedicConfig.prototype.getPlatformId = function() {
    return this._config.platform.split("@")[0];
};

ParamedicConfig.prototype.getPlugins = function () {
    return this._config.plugins;
};

ParamedicConfig.prototype.getExternalServerUrl= function () {
    return this._config.externalServerUrl;
};

ParamedicConfig.prototype.isVerbose = function() {
    return this._config.verbose;
};

ParamedicConfig.prototype.isJustBuild = function() {
    return this._config.justbuild;
};

ParamedicConfig.prototype.shouldUseSauce = function() {
    return this._config.shouldUseSauce;
};

ParamedicConfig.prototype.isBrowserify = function() {
    return this._config.browserify;
};

ParamedicConfig.prototype.getPorts = function() {
    return {
        start: this._config.startPort || DEFAULT_START_PORT,
        end: this._config.endPort || DEFAULT_END_PORT
    };
};

ParamedicConfig.prototype.getTimeout = function() {
    return DEFAULT_TIMEOUT;
};

module.exports = ParamedicConfig;
