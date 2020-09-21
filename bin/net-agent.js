/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 * Copyright 2022 MNX Cloud, Inc.
 */

/*
 * net-agent.js
 */

'use strict';

var fs = require('fs');
var bunyan = require('bunyan');
var bunyanSerializers = require('sdc-bunyan-serializers');

var logLevel = (process.env.LOG_LEVEL || 'debug');
var logger = bunyan.createLogger({
    name: 'net-agent',
    level: logLevel,
    serializers: bunyanSerializers.serializers
});

var NetAgent = require('../lib');
var mod_common = require('../lib/common');

var NET_AGENT_CONFIG_PATH = '/opt/smartdc/agents/etc/net-agent.config.json';
var NET_AGENT_CONFIG_SLEEP = 10000;

/**
 * Wait until our configuration file appears, and then try to parse it.
 */
function loadConfig(callback) {
    var txt, config;

    try {
        txt = fs.readFileSync(NET_AGENT_CONFIG_PATH, 'utf-8');
    } catch (e) {
        logger.error(e,
            'Could not read agent configuration at %s', NET_AGENT_CONFIG_PATH);
        setTimeout(loadConfig, NET_AGENT_CONFIG_SLEEP, callback);
        return;
    }

    try {
        config = JSON.parse(txt);
    } catch (e) {
        callback(e);
        return;
    }

    callback(null, config);
}

loadConfig(function afterLoadConfig(err, config) {
    if (err) {
        logger.fatal('Failed to initialize net-agent configuration');
        process.exit(1);
    }

    if (!config.no_rabbit) {
        logger.warn('"no_rabbit" flag is not true, net-agent will now sleep');
        /*
         * http://nodejs.org/docs/latest/api/all.html#all_settimeout_cb_ms
         * The timeout must be in the range of 1 to 2,147,483,647 inclusive...
         */
        setInterval(function () {}, 2000000000);
        return;
    }

    config.log = logger;

    mod_common.loadSysinfo(function (err2, sysinfo) {
        if (err2) {
            logger.fatal('Failed to load sysinfo for net-agent configuration');
            process.exit(1);
        }
        config.sysinfo = sysinfo;

        var netagent = new NetAgent(config);

        netagent.start();
    });
});
