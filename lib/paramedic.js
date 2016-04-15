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

var exec = require('./utils').exec,
    execPromise = require('./utils').execPromise,
    shell = require('shelljs'),
    Server = require('./LocalServer'),
    Q = require('q'),
    tmp = require('tmp'),
    PluginsManager = require('./PluginsManager'),
    path = require('path'),
    Q = require('q'),
    fs = require('fs'),
    request = require('request'),
    wd = require('wd'),
    getReporters = require('./Reporters'),
    logger = require('./utils').logger;

// Time to wait for initial device connection.
// If device has not connected within this interval the tests are stopped.
var INITIAL_CONNECTION_TIMEOUT = 300000; // 5mins

var SAUCE_USER_ENV_VAR = 'SAUCE_USER';
var SAUCE_KEY_ENV_VAR = 'SAUCE_ACCESS_KEY';

function ParamedicRunner(config, _callback) {
    this.tempFolder = null;
    this.pluginsManager = null;

    this.config = config;

    exec.setVerboseLevel(config.isVerbose());
}

ParamedicRunner.prototype.run = function() {
    var self = this;

    this.checkSauceRequirements();

    return Q().then(function() {
        self.createTempProject();
        self.prepareProjectToRunTests();
        return Server.startServer(self.config.getPorts(), self.config.getExternalServerUrl(), self.config.getUseTunnel());
    })
    .then(function(server) {
        self.server = server;

        self.injectReporters();
        self.subcribeForEvents();

        var connectionUrl = server.getConnectionUrl(self.config.getPlatformId());
        self.writeMedicConnectionUrl(connectionUrl);

        return self.runTests();
    })
    .fin(function() {
        self.cleanUpProject();
    });
};

ParamedicRunner.prototype.createTempProject = function() {
    this.tempFolder = tmp.dirSync();
    tmp.setGracefulCleanup();
    logger.info("cordova-paramedic: creating temp project at " + this.tempFolder.name);
    exec('cordova create ' + this.tempFolder.name);
    shell.pushd(this.tempFolder.name);
};

ParamedicRunner.prototype.prepareProjectToRunTests = function() {
    this.installPlugins();
    this.setUpStartPage();
    this.installPlatform();
    this.checkPlatformRequirements();
};

ParamedicRunner.prototype.installPlugins = function() {
    logger.info("cordova-paramedic: installing plugins");
    this.pluginsManager = new PluginsManager(this.tempFolder.name, this.storedCWD);
    this.pluginsManager.installPlugins(this.config.getPlugins());
    this.pluginsManager.installTestsForExistingPlugins();
    this.pluginsManager.installSinglePlugin('cordova-plugin-test-framework');
    this.pluginsManager.installSinglePlugin('cordova-plugin-device');
    this.pluginsManager.installSinglePlugin(path.join(__dirname, '../paramedic-plugin'));
};

ParamedicRunner.prototype.setUpStartPage = function() {
    logger.normal("cordova-paramedic: setting app start page to test page");
    shell.sed('-i', 'src="index.html"', 'src="cdvtests/index.html"', 'config.xml');
};

ParamedicRunner.prototype.installPlatform = function() {
    logger.info("cordova-paramedic: adding platform : " + this.config.getPlatform());
    exec('cordova platform add ' + this.config.getPlatform());
};

ParamedicRunner.prototype.checkPlatformRequirements = function() {
    logger.normal("cordova-paramedic: checking requirements for platform " + this.config.getPlatformId());
    var result = exec('cordova requirements ' + this.config.getPlatformId());

    if (result.code !== 0)
        throw new Error('Platform requirements check has failed!');
};

ParamedicRunner.prototype.injectReporters = function() {
    var self = this;
    var reporters = getReporters(self.config.getReportSavePath());

    ['jasmineStarted', 'specStarted', 'specDone',
    'suiteStarted', 'suiteDone', 'jasmineDone'].forEach(function(route) {
        reporters.forEach(function(reporter) {
            if (reporter[route] instanceof Function)
                self.server.on(route, reporter[route].bind(reporter));
        });
    });
};

ParamedicRunner.prototype.subcribeForEvents = function() {
    this.server.on('deviceLog', function(data) {
        logger.verbose('device|console.' + data.type + ': '  + data.msg[0]);
    });

    this.server.on('deviceInfo', function(data) {
        logger.normal('cordova-paramedic: Device info: ' + JSON.stringify(data));
    });
};

ParamedicRunner.prototype.writeMedicConnectionUrl = function(url) {
    logger.normal("cordova-paramedic: writing medic log url to project " + url);
    fs.writeFileSync(path.join("www","medic.json"), JSON.stringify({logurl:url}));
};

ParamedicRunner.prototype.waitForTests = function() {
    var self = this;
    logger.info('cordova-paramedic: waiting for test results');
    return Q.promise(function(resolve, reject) {
        self.server.on('jasmineDone', function(data) {
            logger.info('cordova-paramedic: tests have been completed');

            var isTestPassed = (data.specResults.specFailed === 0);

            resolve(isTestPassed);
        });

        self.server.on('disconnect', function() {
            reject(new Error('device is disconnected before passing the tests'));
        });
    });
};

ParamedicRunner.prototype.runTests = function() {
    if (this.config.shouldUseSauce()) {
        var command = this.getCommandForBuilding();
        logger.normal('cordova-paramedic: running command ' + command);

        return execPromise(this.getCommandForBuilding())
        .then(this.runSauceTests.bind(this));
    } else {
        var self = this;
        var command = self.getCommandForStartingTests();
        logger.normal('cordova-paramedic: running command ' + command);

        return execPromise(command)
        .then(function(code, output) {
            // skip tests if it was just build
            if (self.shouldWaitForTestResult()) {
                // reject if device not connected in pending time
                return self.waitForConnection()
                .catch(reject)
                .then(self.waitForTests.bind(self))
                .then(resolve);
            }
        }, function(code, output) {
            // this trace is automatically available in verbose mode
            // so we check for this flag to not trace twice
            if (!self.config.verbose) {
                logger.normal(output);
            }
            logger.normal('cordova-paramedic: unable to run tests; command log is available above');
            throw new Error(command + " returned error code " + code);
        });
    }
};

ParamedicRunner.prototype.getCommandForStartingTests = function() {
    var cmd = "cordova " + this.config.getAction() + " " + this.config.getPlatformId();

    if (this.config.getArgs()) {
        cmd += " " + this.config.getArgs();
    }

    return cmd;
};

ParamedicRunner.prototype.getCommandForBuilding = function() {
    var cmd = "cordova build " + this.config.getPlatformId();

    return cmd;
};

ParamedicRunner.prototype.shouldWaitForTestResult = function() {
    var action = this.config.getAction();
    return action === 'run' || action  === 'emulate';
};

ParamedicRunner.prototype.waitForConnection = function() {
    var self = this;

    var ERR_MSG = 'Seems like device not connected to local server in ' + INITIAL_CONNECTION_TIMEOUT / 1000 + ' secs';

    return Q.promise(function(resolve, reject) {
        setTimeout(function() {
            if (!self.server.isDeviceConnected()) {
                reject(new Error(ERR_MSG));
            } else {
                resolve();
            }
        }, INITIAL_CONNECTION_TIMEOUT);
    });
};

ParamedicRunner.prototype.cleanUpProject = function() {
    if(this.config.getShouldCleanUpAfterRun()) {
        logger.info("cordova-paramedic: Deleting the application: " + this.tempFolder.name);
        shell.popd();
        shell.rm('-rf', this.tempFolder.name);
    }
};

ParamedicRunner.prototype.checkSauceRequirements = function() {
    if (this.config.shouldUseSauce()) {
        if (this.config.getPlatformId() !== 'android' && this.config.getPlatformId() !== 'ios') {
            throw new Error('Sauce Labs only supports Android and iOS');
        } else if (!process.env[SAUCE_KEY_ENV_VAR]) {
            throw new Error(SAUCE_KEY_ENV_VAR + ' environment variable not set');
        } else if (!process.env[SAUCE_USER_ENV_VAR]) {
            throw new Error(SAUCE_USER_ENV_VAR + ' environment variable not set');
        } else if (!this.shouldWaitForTestResult()) {
            throw new Error('justBuild cannot be used with shouldUseSauce');
        }
    }
};

ParamedicRunner.prototype.uploadApp = function() {
    logger.normal('cordova-paramedic: uploading ' + this.getAppName() + ' to Sauce Storage');
    var sauceUser = process.env[SAUCE_USER_ENV_VAR];
    var key = process.env[SAUCE_KEY_ENV_VAR];

    var appPostForm = {

        custom_file: {
            value: fs.createReadStream(this.getBinaryPath()),
            options: {
                filename: this.getAppName(),
                contentType: 'application/octet-stream'
            }
        }
    };

    var self = this;

    return Q.promise(function(resolve, reject) {
        request.post({
            url: encodeURI('https://saucelabs.com/rest/v1/storage/' + sauceUser + '/' + self.getAppName() + '?overwrite=true'),
            formData: appPostForm,
            auth: {
                user: sauceUser,
                pass: key
            }
        }, function(err, httpResponse, body) {
            if (err) {
                reject(err);
            } else {
                resolve(httpResponse, body);
            }
        });
    });
};

ParamedicRunner.prototype.getBinaryPath = function() {
    var binaryPath;
    switch (this.config.getPlatformId()) {
        case 'android':
            binaryPath = path.join(this.tempFolder.name, 'platforms', 'android', 'build', 'outputs', 'apk', 'android-debug.apk');
            break;
        case 'ios':
            binaryPath = path.join(this.tempFolder.name, 'platforms', 'ios', 'build', 'device', 'mobilespec.ipa');
            break;
        default:
            throw new Error('Unsupported platform for sauce labs testing');
    }
    return binaryPath;
};

ParamedicRunner.prototype.getAppName = function() {
    var ext;
    switch (this.config.getPlatformId()) {
        case 'android':
            ext = 'android-debug.apk';
            break;
        case 'ios':
            ext = 'mobilespec.ipa';
            break;
        default:
            throw new Error('Unsupported platform for sauce labs testing');
    }
    return ext;
};

ParamedicRunner.prototype.runSauceTests = function() {
    logger.info('cordova-paramedic: running sauce tests');
    var self = this;

    return self.uploadApp().then(function() {
        var user = process.env[SAUCE_USER_ENV_VAR];
        var key = process.env[SAUCE_KEY_ENV_VAR];

        var caps = {};
        caps['name'] = 'Paramedic Sauce test #5git ';
        caps['browserName'] = '';
        caps['appiumVersion'] = '1.5.1';
        caps['deviceOrientation'] = 'portrait';
        caps['deviceType'] = 'phone';
        caps['app'] = 'sauce-storage:' + self.getAppName();

        switch(self.config.getPlatformId()) {
            case 'android':
                caps['deviceName'] = 'Android Emulator';
                caps['platformVersion'] = '4.4';
                caps['platformName'] = 'Android';
                caps['appPackage'] = 'io.cordova.hellocordova';
                caps['appActivity'] = 'io.cordova.hellocordova.MainActivity';
                break;
            case 'ios':
                caps['deviceName'] = 'iPhone Simulator';
                caps['platformVersion'] = '9.2';
                caps['platformName'] = 'iOS';
                break;
            default:
                throw new Error('Unsupported platform for sauce labs testing');
        }



        return Q.promise(function(resolve, reject) {
            var driver = wd.remote('ondemand.saucelabs.com', 80, user, key);
            driver.init(caps, function(error) {
                if (error) {
                    throw new Error('Error starting Appium web driver');
                }

                self.waitForConnection()
                .then(self.waitForTests.bind(self))
                .done(function() {
                    driver.quit();
                    resolve();
                }, function() {
                    driver.quit();
                    reject();
                });
            });
        });
    });
};

var storedCWD =  null;

exports.run = function(paramedicConfig) {

    storedCWD = storedCWD || process.cwd();

    var runner = new ParamedicRunner(paramedicConfig, null);
    runner.storedCWD = storedCWD;

    return runner.run()
    .timeout(paramedicConfig.getTimeout(), "This test seems to be blocked :: timeout exceeded. Exiting ...");
};
