/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Test helpers for dealing with NICs
 */

'use strict';

var assert = require('assert-plus');
var common = require('./common');
var log = require('./log');
var mod_client = require('./client');
var mod_jsprim = require('jsprim');
var mod_vasync = require('vasync');
var verror = require('verror');

var clone = mod_jsprim.deepCopy;
var doneRes = common.doneRes;
var doneErr = common.doneErr;



// --- Globals

var TYPE = 'nic';


// --- Exports

/**
 * Create a nic and compare the output
 */
function createNic(t, opts, callback) {
    var client = opts.client || mod_client.get();

    assert.object(t, 't');
    assert.string(opts.mac, 'opts.mac');
    assert.optionalObject(opts.expErr, 'opts.expErr');
    assert.optionalObject(opts.partialExp, 'opts.partialExp');
    assert.ok(opts.exp || opts.partialExp || opts.expErr,
            'one of exp, expErr, partialExp required');
    assert.object(opts.params, 'opts.params');

    var mac = opts.mac;
    if (mac === 'generate') {
        mac = common.randomMAC();
    }
    opts.idKey = 'mac';
    opts.type = TYPE;
    opts.reqType = 'create';


    client.createNic(mac, clone(opts.params), common.reqOpts(t, opts),
        common.afterAPIcall.bind(null, t, opts, callback));
}


/**
 * Create a nic, compare the output, then do the same for a get of
 * that nic.
 */
function createAndGetNic(t, opts, callback) {
    createNic(t, opts, function (err, _, req, res) {
        if (err) {
            doneErr(err, t, callback);
            return;
        }

        opts.etag = res.headers['etag'];

        getNic(t, opts, callback);
    });
}


/**
 * Create num nics, and end the test when done
 */
function createNumNics(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.number(opts.num, 'opts.num');
    assert.object(opts.params, 'opts.params');

    var done = 0;
    var errs = [];
    var nics = [];

    opts.mac = 'generate';

    // Don't require checking parameters
    if (!opts.exp && !opts.params.partialExp) {
        opts.partialExp = opts.params;
    }

    function _afterProvision(err, nic) {
        if (err) {
            errs.push(err);
        }

        if (nic) {
            nics.push(nic);
        }

        if (++done === opts.num) {
            if (errs.length !== 0) {
                doneErr(new verror.MultiError(errs), t, callback);
                return;
            }

            doneRes(nics, t, callback);
            return;
        }
    }

    for (var i = 0; i < opts.num; i++) {
        createNic(t, opts, _afterProvision);
    }
}


/**
 * Delete all the nics created by this test
 */
function delAllCreatedNics(t) {
    assert.object(t, 't');

    var created = common.allCreated('nics');
    if (created.length === 0) {
        t.pass('No nics created');
        t.end();
        return;
    }

    common.clearCreated('nics');

    var q = mod_vasync.queue(function _delOne(nic, cb) {
        var delOpts = {
            mightNotExist: true,
            continueOnErr: true,
            exp: {},
            params: nic,
            mac: nic.mac
        };

        delNic(t, delOpts, cb);
    }, 100);

    q.on('end', function () {
        t.end();
    });

    q.push(created);
    q.close();
}


/**
 * Delete a nic
 */
function delNic(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.string(opts.mac, 'opts.mac');

    var client = mod_client.get();
    var params = opts.params || {};

    log.debug({ mac: opts.mac }, 'delete nic');
    opts.id = opts.mac;
    opts.type = TYPE;

    client.deleteNic(opts.mac, params, common.reqOpts(t, opts),
        common.afterAPIdelete.bind(null, t, opts, callback));
}


/**
 * Get a nic and compare the output
 */
function getNic(t, opts, callback) {
    common.assertArgs(t, opts, callback);

    var client = opts.client || mod_client.get();

    assert.object(t, 't');
    assert.string(opts.mac, 'opts.mac');
    assert.optionalObject(opts.exp, 'opts.exp');
    assert.optionalObject(opts.expErr, 'opts.expErr');
    assert.optionalObject(opts.partialExp, 'opts.partialExp');
    assert.ok(opts.exp || opts.partialExp || opts.expErr,
            'one of exp, expErr, partialExp required');

    opts.type = TYPE;
    opts.reqType = 'get';
    client.getNic(opts.mac, common.reqOpts(t, opts),
        common.afterAPIcall.bind(null, t, opts, callback));
}


/**
 * Returns the most recently created nic
 */
function lastCreatedNic() {
    return common.lastCreated('nics');
}


/**
 * List networks
 */
function listNics(t, opts, callback) {
    common.assertArgsList(t, opts, callback);

    var client = opts.client || mod_client.get();
    var params = opts.params || {};
    var desc = ' ' + JSON.stringify(params)
        + (opts.desc ? (' ' + opts.desc) : '');

    if (!opts.desc) {
        opts.desc = desc;
    }
    opts.id = 'mac';
    opts.type = TYPE;
    opts.reqType = 'list';

    log.debug({ params: params }, 'list networks');

    client.listNics(params, common.reqOpts(t, opts),
        common.afterAPIlist.bind(null, t, opts, callback));
}


/**
 * Provision a nic and compare the output
 */
function provisionNic(t, opts, callback) {
    common.assertArgs(t, opts, callback);
    assert.uuid(opts.net, 'opts.net');

    var client = opts.client || mod_client.get();
    log.debug({ params: opts.params }, 'provisioning nic');
    opts.idKey = 'mac';
    opts.type = TYPE;
    opts.reqType = 'create';

    if (opts.exp && opts.fillInMissing) {
        opts.fillIn = [ 'ip', 'mac', 'primary', 'state' ];
    }

    client.provisionNic(opts.net, opts.params, common.reqOpts(t, opts),
        common.afterAPIcall.bind(null, t, opts, callback));
}


/**
 * Update a nic and compare the output
 */
function updateNic(t, opts, callback) {
    common.assertArgs(t, opts, callback);
    assert.string(opts.mac, 'opts.mac');

    var client = opts.client || mod_client.get();
    opts.type = TYPE;
    opts.reqType = 'update';

    client.updateNic(opts.mac, opts.params, common.reqOpts(t, opts),
        common.afterAPIcall.bind(null, t, opts, callback));
}


/**
 * Update a nic, compare the output, then do the same for a get of
 * that nic.
 */
function updateAndGet(t, opts, callback) {
    updateNic(t, opts, function (err, res) {
        if (err) {
            doneErr(err, t, callback);
            return;
        }

        getNic(t, opts, callback);
    });
}



module.exports = {
    create: createNic,
    createAndGet: createAndGetNic,
    createN: createNumNics,
    delAllCreated: delAllCreatedNics,
    del: delNic,
    get: getNic,
    lastCreated: lastCreatedNic,
    list: listNics,
    provision: provisionNic,
    update: updateNic,
    updateAndGet: updateAndGet
};
