/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Common test helpers shared between integration and unit tests
 */

'use strict';

var assert = require('assert-plus');
var fmt = require('util').format;
var mod_common = require('../../lib/common');
var mod_jsprim = require('jsprim');
var mod_uuid = require('uuid');
var NAPI = require('sdc-clients').NAPI;
var util = require('util');

var clone = mod_jsprim.deepCopy;


var CREATED = {};

// --- Private functions

/*
 * check if {created,modified}_timestamp are returned with sane values
 * on creation or modification, as well as adjust opts as necessary
 * so t.deepEquals() is kept happy
 *
 * Optionally, opts.ts can be used to track the timestamps
 * across multiple invocations to make sure the values are
 * being updated as expected.
 */
function checkTimestamps(t, type, desc, opts, obj) {
    assert.optionalObject(opts.ts, 'opts.ts');

    var supportedTypes = [ 'nic' ];

    if (supportedTypes.indexOf(opts.type) < 0) {
        return;
    }

    switch (opts.reqType) {
        case 'create':
            t.notEqual(obj.created_timestamp, 0,
                type + 'created ts > 0' + desc);
            t.notEqual(obj.modified_timestamp, 0,
                type + 'modified ts > 0' + desc);
            t.equal(obj.created_timestamp, obj.modified_timestamp,
                type + 'created and modified ts equal at creation' + desc);

            if (opts.ts) {
                opts.ts.created_timestamp = obj.created_timestamp;
                opts.ts.modified_timestamp = obj.modified_timestamp;
            }
            break;

        case 'get':
        case 'list':
            // existing objects might not yet have timestamps, so can return 0
            t.ok(obj.created_timestamp,
                type + 'created ts exists' + desc);
            t.ok(obj.modified_timestamp,
                type + 'modified ts exsists' + desc);

            if (opts.ts) {
                t.equal(obj.modified_timestamp, opts.ts.modified_timestamp,
                    type + 'modified ts unchanged on get' + desc);
            }
            break;

        case 'update':
            t.notEqual(obj.created_timestamp, 0,
                type + 'created ts set' + desc);
            t.notEqual(obj.modified_timestamp, 0,
                type + 'modified ts set' + desc);
            t.ok(obj.modified_timestamp > obj.created_timestamp,
                type + 'modified ts > created ts on update' + desc);

            if (opts.ts) {
                t.ok(obj.modified_timestamp > opts.ts.modified_timestamp,
                    type + 'modified ts increasing after update' + desc);
                opts.ts.modified_timestamp = obj.modified_timestamp;
            }
            break;

        default:
            return;
    }

    if (opts.exp) {
        var ignore = opts.ignore ? opts.ignore : [];

        // skip implicit checks if caller explicity specifies a value
        if (!opts.exp.created_timestamp) {
            if (ignore.indexOf('created_timestamp') < 0) {
                ignore.push('created_timestamp');
            }
        }

        if (!opts.exp.modified_timestamp) {
            if (ignore.indexOf('modified_timestamp') < 0) {
                ignore.push('modified_timestamp');
            }
        }

        opts.ignore = ignore;
    }
}

// --- Exported functions



/**
 * Adds the given object to:
 * - CREATED[type]
 * - opts.state (if opts and opts.state are present)
 */
function addToState(opts, type, obj) {
    if (!CREATED.hasOwnProperty(type)) {
        CREATED[type] = [];
    }

    CREATED[type].push(obj);

    if (!opts.state || !obj) {
        return;
    }

    if (!opts.state.hasOwnProperty(type)) {
        opts.state[type] = [];
    }

    var newObj = clone(obj);
    if (opts.hasOwnProperty('stateProp')) {
        if (!opts.state.hasOwnProperty(opts.stateProp)) {
            opts.state[opts.stateProp] = [];
        }

        opts.state[opts.stateProp].push(newObj);
    }

    opts.state[type].push(newObj);
}

function requestHeaders(opts) {
    var headers = opts.headers || {};

    headers['x-request-id'] = mod_uuid.v4();

    if (opts.etag) {
        headers['If-Match'] = opts.etag;
    }

    return headers;
}

/**
 * Shared test code for after API methods are called
 */
function afterAPIcall(t, opts, callback, err, obj, req, res) {
    var desc = opts.desc ? (' ' + opts.desc) : '';
    assert.string(opts.reqType, 'opts.reqType');
    assert.string(opts.type, 'opts.type');
    var type = opts.reqType + ' ' + opts.type + ': ';

    if (opts.expErr) {
        t.ok(err, type + 'expected error' + desc);
        if (err) {
            var code = opts.expCode || 422;
            t.equal(err.statusCode, code, type + 'status code' + desc);
            t.deepEqual(err.body, opts.expErr, type + 'error body' + desc);
        }

        if (obj) {
            t.deepEqual(obj, {}, 'body (error expected)' + desc);
        }

        done(err, null, req, res, opts, t, callback);
        return;
    }

    if (ifErr(t, err, type + desc)) {
        done(err, null, req, res, opts, t, callback);
        return;
    }

    if (res) {
        t.equal(res.statusCode, 200, 'status code' + desc);
    }

    if (opts.hasOwnProperty('idKey')) {
        t.pass(fmt('created %s "%s"', opts.type, obj[opts.idKey]));
    }

    checkTimestamps(t, type, desc, opts, obj);

    if (opts.exp) {
        /*
         * For creates, the server will generate an ID (usually a UUID) if
         * it's not set in the request.  Copy this over to the expected
         * object so that we don't have to set it manually:
         */
        if (opts.hasOwnProperty('idKey') &&
                !opts.exp.hasOwnProperty(opts.idKey)) {
            opts.exp[opts.idKey] = obj[opts.idKey];
        }

        /*
         * Allow filling in values that might be generated before doing the
         * deepEqual below:
         */
        if (opts.hasOwnProperty('fillIn')) {
            opts.fillIn.forEach(function (prop) {
                if (!opts.exp.hasOwnProperty(prop) &&
                    obj.hasOwnProperty(prop)) {
                    opts.exp[prop] = obj[prop];
                }
            });
        }

        var actual = obj;
        var expected = opts.exp;

        if (opts.hasOwnProperty('ignore')) {
            var objClone = clone(obj);
            var expClone = clone(opts.exp);

            opts.ignore.forEach(function (ign) {
                delete objClone[ign];
                delete expClone[ign];
            });

            actual = objClone;
            expected = expClone;
        }

        t.deepEqual(actual, expected, type + 'full result' + desc);
    }

    if (opts.partialExp) {
        var partialRes = {};
        for (var p in opts.partialExp) {
            partialRes[p] = obj[p];
        }

        t.deepEqual(partialRes, opts.partialExp,
            type + 'partial result' + desc);
    }

    if (opts.reqType === 'create') {
        // We take plural names elsewhere, but expect the singular here:
        assert.notEqual('s', opts.type.slice(-1));
        addToState(opts, opts.type + 's', obj);
    }

    done(null, obj, req, res, opts, t, callback);
}


/**
 * Shared test code for after API delete methods are called
 */
function afterAPIdelete(t, opts, callback, err, obj, req, res) {
    var desc = opts.desc ? (' ' + opts.desc) : '';
    assert.string(opts.type, 'opts.type');
    assert.string(opts.id, 'opts.id');
    var type = util.format('delete %s %s: ', opts.type, opts.id);

    if (opts.expErr) {
        t.ok(err, 'expected error');
        if (err) {
            var code = opts.expCode || 422;
            t.equal(err.statusCode, code, 'status code');
            t.deepEqual(err.body, opts.expErr, 'error body');
        }

        done(err, null, req, res, opts, t, callback);
        return;
    }

    /*
     * mightNotExist allows for calling mod_whatever.dellAllCreated() when
     * some of the created objects were actually deleted during the test:
     */
    if (opts.mightNotExist && err && err.restCode === 'ResourceNotFound') {
        done(null, obj, req, res, opts, t, callback);
        return;
    }

    if (ifErr(t, err, type + desc)) {
        done(err, null, req, res, opts, t, callback);
        return;
    }

    if (res) {
        t.equal(res.statusCode, 204, type + 'status code' + desc);
    }

    done(null, obj, req, res, opts, t, callback);
}


/**
 * Shared test code for after API list methods are called
 */
function afterAPIlist(t, opts, callback, err, obj, req, res) {
    assert.string(opts.type, 'opts.type');
    assert.string(opts.id, 'opts.id');
    assert.optionalArray(opts.present, 'opts.present');

    var desc = opts.desc ? (' ' + opts.desc) : '';
    var id = opts.id;
    var type = opts.type;

    if (opts.expErr) {
        t.ok(err, type + 'expected error' + desc);
        if (err) {
            var code = opts.expCode || 422;
            t.equal(err.statusCode, code, type + 'status code' + desc);
            t.deepEqual(err.body, opts.expErr, type + 'error body' + desc);
        }

        done(err, null, req, res, opts, t, callback);
        return;
    }

    if (ifErr(t, err, type + desc)) {
        done(err, null, req, res, opts, t, callback);
        return;
    }

    t.equal(res.statusCode, 200, 'status code' + desc);
    t.pass(obj.length + ' results returned' + desc);

    if (opts.present) {
        var left = clone(opts.present);
        var ids = left.map(function (o) { return o[id]; });
        var present = clone(ids);
        var notInPresent = [];

        mod_jsprim.forEachKey(obj, function (_key, resObj) {
            var idx = ids.indexOf(resObj[id]);
            if (idx !== -1) {
                var expObj = left[idx];
                var partialRes = {};
                for (var p in expObj) {
                    partialRes[p] = resObj[p];
                }

                var tsOpts = {
                    id: opts.id,
                    type: opts.type,
                    reqType: opts.reqType,
                    exp: expObj,
                    ignore: clone(opts.ignore)
                };

                if (opts.ts && opts.ts[idx]) {
                    tsOpts.ts = opts.ts[idx];
                }

                checkTimestamps(t, type, desc, tsOpts, resObj);

                if (opts.deepEqual) {
                    /*
                     * ignore doesn't really make sense in the context of a
                     * partial response.
                     */
                    if (tsOpts.ignore) {
                        var resClone = clone(resObj);
                        var expClone = clone(expObj);

                        tsOpts.ignore.forEach(function (ign) {
                            delete resClone[ign];
                            delete expClone[ign];
                        });

                        resObj = resClone;
                        expObj = expClone;
                    }

                    t.deepEqual(resObj, expObj,
                        'full result for ' + resObj[id] + desc);
                } else {
                    t.deepEqual(partialRes, expObj,
                        'partial result for ' + resObj[id] + desc);
                }

                ids.splice(idx, 1);
                left.splice(idx, 1);
            } else {
                notInPresent.push(resObj);
            }
        });

        t.deepEqual(ids, [],
            'found ' + type + 's not specified in opts.present ' + desc);

        if (ids.length !== 0) {
            t.deepEqual(present, [], 'IDs in present list');
        }

        if (opts.deepEqual) {
            t.deepEqual(notInPresent, [], 'IDs not in present list');
        }
    }

    done(null, obj, req, res, opts, t, callback);
}


/**
 * Gets all of the created objects of the given type
 */
function allCreated(type) {
    return CREATED[type] || [];
}


function clearCreated(type) {
    CREATED[type] = [];
}


function resetCreated() {
    CREATED = {};
}


/**
 * Assert the arguments to one of the helper functions are correct
 */
function assertArgs(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.optionalObject(opts.exp, 'opts.exp');
    assert.optionalObject(opts.expErr, 'opts.expErr');
    assert.optionalObject(opts.partialExp, 'opts.partialExp');
    assert.ok(opts.exp || opts.partialExp || opts.expErr,
        'one of exp, expErr, partialExp required');
    assert.optionalString(opts.etag, 'opts.etag');
    assert.optionalObject(opts.params, 'opts.params');
    assert.optionalObject(opts.state, 'opts.state');
    assert.optionalNumber(opts.delay, 'opts.delay');
    assert.optionalFunc(callback, 'callback');
}


/**
 * Assert the arguments to one of the list helper functions are correct
 */
function assertArgsList(t, opts, callback) {
    assert.object(t, 't');
    assert.object(opts, 'opts');
    assert.optionalObject(opts.params, 'opts.params');
    assert.optionalObject(opts.expErr, 'opts.expErr');
    assert.optionalBool(opts.deepEqual, 'opts.deepEqual');
    assert.optionalArrayOfObject(opts.present, 'opts.present');
    assert.optionalFunc(callback, 'callback');
}


/**
 * Creates a NAPI client for the configured NAPI instance, with a unique
 * req_id.
 */
function createClient(url, t) {
    var reqID = mod_uuid.v4();
    var opts = {
        agent: false,
        headers: { 'x-request-id': reqID },
        url: url
    };

    var client = new NAPI(opts);
    client.req_id = reqID;

    if (t) {
        t.ok(client, 'created client with req_id=' + client.req_id);
    }

    return client;
}


/**
 * Finish a test
 */
function done(err, obj, req, res, opts, t, callback) {
    function _done() {
        if (callback) {
            callback(opts.continueOnErr ? null : err, obj, req, res);
            return;
        }

        t.end();
    }

    if (typeof (opts.delay) === 'number') {
        t.pass('waiting for ' + (opts.delay / 1000) +
            ' seconds before continuing');
        setTimeout(_done, opts.delay);
    } else {
        _done();
    }
}


/**
 * Finish a test with an error
 */
function doneErr(err, t, callback) {
    if (callback) {
        return callback(err);
    }

    return t.end();
}


/**
 * Finish a test with a result
 */
function doneRes(res, t, callback) {
    if (callback) {
        return callback(null, res);
    }

    return t.end();
}


/**
 * Calls t.ifError, outputs the error body for diagnostic purposes, and
 * returns true if there was an error
 */
function ifErr(t, err, desc) {
    t.ifError(err, desc);
    if (err) {
        t.deepEqual(err.body, {}, desc + ': error body');
        return true;
    }

    return false;
}


/**
 * Returns an invalid parameter error body, overriding with fields in
 * extra
 */
function invalidParamErr(extra) {
    assert.optionalObject(extra, 'extra');

    var newErr = {
        code: 'InvalidParameters',
        message: 'Invalid parameters'
    };

    for (var e in extra) {
        newErr[e] = extra[e];
    }

    return newErr;
}


/**
 * Gets the last created object of the given type (eg: nics, networks)
 */
function lastCreated(type) {
    if (!CREATED.hasOwnProperty(type) || CREATED[type].length === 0) {
        return null;
    }

    return CREATED[type][CREATED[type].length - 1];
}


/**
 * Returns an missing parameter error body, overriding with fields in
 * extra
 */
function missingParamErr(extra) {
    assert.optionalObject(extra, 'extra');

    var newErr = {
        code: 'InvalidParameters',
        message: 'Missing parameter'
    };

    for (var e in extra) {
        newErr[e] = extra[e];
    }

    return newErr;
}


/**
 * Generate a valid random MAC address (multicast bit not set, locally
 * administered bit set)
 */
function randomMAC() {
    var data = [(Math.floor(Math.random() * 15) + 1).toString(16) + 2];
    for (var i = 0; i < 5; i++) {
        var oct = (Math.floor(Math.random() * 255)).toString(16);
        if (oct.length === 1) {
            oct = '0' + oct;
        }
        data.push(oct);
    }

    return data.join(':');
}


/**
 * Generate request opts
 */
function requestOpts(t, opts) {
    assert.object(t, 't');

    var desc;
    if (typeof (opts) === 'undefined') {
        desc = '';
        opts = {};
    } else if (typeof (opts) === 'string') {
        desc = ': ' + opts;
        opts = {};
    } else {
        assert.object(opts, 'opts');
        desc = opts.desc ? ': ' + opts.desc : '';
    }

    var headers = requestHeaders(opts);
    var reqId = headers['x-request-id'];

    t.ok(reqId, fmt('req ID: %s%s', reqId, desc));

    return { headers: headers };
}


/**
 * Sort by uuid property
 */
function uuidSort(a, b) {
    return (a.uuid > b.uuid) ? 1 : -1;
}



module.exports = {
    addToState: addToState,
    afterAPIcall: afterAPIcall,
    afterAPIdelete: afterAPIdelete,
    afterAPIlist: afterAPIlist,
    allCreated: allCreated,
    assertArgs: assertArgs,
    assertArgsList: assertArgsList,
    clearCreated: clearCreated,
    resetCreated: resetCreated,
    createClient: createClient,
    doneErr: doneErr,
    doneRes: doneRes,
    ifErr: ifErr,
    invalidParamErr: invalidParamErr,
    lastCreated: lastCreated,
    loadSysinfo: mod_common.loadSysinfo,
    missingParamErr: missingParamErr,
    randomMAC: randomMAC,
    reqHeaders: requestHeaders,
    reqOpts: requestOpts,
    uuidSort: uuidSort
};
