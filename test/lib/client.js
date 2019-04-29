/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Test helpers for dealing with the NAPI client
 */

'use strict';

var config = require('./config');
var log = require('./log');
var mod_clients = require('sdc-clients');
var mod_common = require('../../lib/common');
var mod_util = require('util');


// --- Globals

var naVersion = mod_common.getNetAgentVersion();

var userAgent = mod_util.format(
    'net-agent-test/%s (node/%s) server/%s',
    naVersion, process.versions.node, config.cn_uuid);

var CLIENT = new mod_clients.NAPI({
    url: config.napi.url,
    log: log,
    agent: false,
    retry: false,
    userAgent: userAgent
});


// --- Exports

function getClient() {
    return CLIENT;
}

module.exports = {
    get: getClient
};
