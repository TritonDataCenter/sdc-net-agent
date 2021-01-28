/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');
var mod_common = require('./common');
var mod_util = require('util');

// --- Globals

var DIFF_FIELDS = [
];

// --- Exports

function VpcFSM(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.app, 'opts.app');

    this.app = opts.app;
    this.log = opts.app.log.child({
        component: 'vpc'});
}

module.exports = VpcFSM;
