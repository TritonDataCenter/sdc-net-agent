/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

/*
 * Test helpers for dealing with VMs
 */

'use strict';

var assert = require('assert-plus');
var log = require('./log');
var mod_common = require('./common');
var mod_vmadm = require('vmadm');

var doneErr = mod_common.doneErr;

// --- Globals

var TYPE = 'vm';

// --- Exports

function createVm(t, opts, callback) {
    mod_common.assertArgs(t, opts, callback);

    var params = opts.params;
    params.log = log;

    opts.idKey = 'uuid';
    opts.type = TYPE;
    opts.reqType = 'create';

    mod_vmadm.create(params, function (err, info) {
        mod_common.afterAPIcall(t, opts, callback, err, info);
    });
}

function createAndGetVm(t, opts, callback) {
    createVm(t, {
        params: opts.params,
        partialExp: {},
        delay: opts.delay
    }, function (err, info) {
        if (err) {
            doneErr(err, t, callback);
            return;
        }

        opts.uuid = info.uuid;

        getVm(t, opts, callback);
    });
}

function updateVm(t, opts, callback) {
    mod_common.assertArgs(t, opts, callback);
    assert.uuid(opts.uuid, 'opts.uuid');

    var params = opts.params;
    params.uuid = opts.uuid;
    params.log = log;

    opts.type = TYPE;
    opts.reqType = 'update';

    mod_vmadm.update(params, function (err) {
        mod_common.afterAPIcall(t, opts, callback, err, { uuid: opts.uuid });
    });
}

function updateAndGetVm(t, opts, callback) {
    mod_common.assertArgs(t, opts, callback);

    updateVm(t, {
        uuid: opts.uuid,
        params: opts.params,
        partialExp: {},
        delay: opts.delay
    }, function (err) {
        if (err) {
            doneErr(err, t, callback);
            return;
        }

        getVm(t, opts, callback);
    });
}

function delVm(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');

    opts.id = opts.uuid;
    opts.type = TYPE;
    opts.reqType = 'delete';

    mod_vmadm.delete({
        uuid: opts.uuid,
        log: log
    }, function (err) {
        mod_common.afterAPIdelete(t, opts, callback, err);
    });
}

function getVm(t, opts, callback) {
    mod_common.assertArgs(t, opts, callback);
    assert.uuid(opts.uuid, 'opts.uuid');

    opts.type = TYPE;
    opts.reqType = 'get';

    mod_vmadm.load({
        uuid: opts.uuid,
        log: log
    }, function (err, vm) {
        mod_common.afterAPIcall(t, opts, callback, err, vm);
    });
}

function startVm(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');

    opts.type = TYPE;
    opts.reqType = 'stop';

    mod_vmadm.start({
        uuid: opts.uuid,
        log: log
    }, function (err) {
        mod_common.afterAPIcall(t, opts, callback, err);
    });
}
function stopVm(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.uuid(opts.uuid, 'opts.uuid');

    opts.type = TYPE;
    opts.reqType = 'stop';

    mod_vmadm.stop({
        uuid: opts.uuid,
        log: log
    }, function (err) {
        mod_common.afterAPIcall(t, opts, callback, err);
    });
}

module.exports = {
    create: createVm,
    createAndGet: createAndGetVm,
    del: delVm,
    get: getVm,
    update: updateVm,
    updateAndGet: updateAndGetVm,
    start: startVm,
    stop: stopVm
};
