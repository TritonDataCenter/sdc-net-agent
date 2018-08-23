/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018 Joyent, Inc.
 */

/*
 * net-agent.js
 */

'use strict';

var child_process = require('child_process');
var fs = require('fs');
var path = require('path');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var bunyanSerializers = require('sdc-bunyan-serializers');
var DummyVmadm = require('vmadm/lib/index.dummy');
var uuidv4 = require('uuid/v4');
var vasync = require('vasync');

var NetAgent = require('../lib');

var logLevel = (process.env.LOG_LEVEL || 'debug');
var logger = bunyan.createLogger({
    name: 'net-agent',
    level: logLevel,
    serializers: bunyanSerializers
});


// This will blow up if something goes wrong. That's what we want.
var MOCKCLOUD_ROOT = process.env.MOCKCLOUD_ROOT ||
    child_process.execSync('/usr/sbin/mdata-get mockcloudRoot',
    {encoding: 'utf8'}).trim();
var SERVER_ROOT = MOCKCLOUD_ROOT + '/servers';


function mdataGet(key, callback) {
    assert.string(key, 'key');
    assert.func(callback, 'callback');

    child_process.execFile('/usr/sbin/mdata-get', [
        key
    ], function _onMdata(err, stdout, stderr) {
        assert.ifError(err, 'mdata-get should always work');

        callback(null, stdout.trim());
    });
}

function loadSysinfo(server_uuid, callback) {
    var filename = SERVER_ROOT + '/' + server_uuid + '/sysinfo.json';

    fs.readFile(filename, function onData(err, data) {
        if (err) {
            callback(err);
            return;
        }

        callback(null, JSON.parse(data.toString()));
    });
}

// TODO: should use common method in backends to get rackaware admin IP.
// For now, just copied this from cn-agent.
function findZoneAdminIp(ctx, callback) {
    mdataGet('sdc:nics', function _onMdata(err, nicsData) {
        var idx;
        var nic;
        var nics = JSON.parse(nicsData.toString());

        for (idx = 0; idx < nics.length; idx++) {
            nic = nics[idx];
            if (nic.nic_tag === 'admin') {
                ctx.bindIP = nic.ip;
                break;
            }
        }

        assert.string(ctx.bindIP, 'ctx.bindIP');

        callback();
    });
}

function findUfdsAdminUuid(ctx, callback) {
    mdataGet('ufdsAdmin', function _onMdata(err, data) {

        ctx.ufdsAdminUuid = data.toString();
        assert.uuid(ctx.ufdsAdminUuid, 'ctx.ufdsAdminUuid');

        callback();
    });
}

function findDnsDomain(ctx, callback) {
    mdataGet('dnsDomain', function _onMdata(err, data) {

        ctx.dnsDomain = data.toString();
        assert.string(ctx.dnsDomain, 'ctx.dnsDomain');

        callback();
    });
}

function findDatacenterName(ctx, callback) {
    mdataGet('sdc:datacenter_name', function _onMdata(err, data) {

        ctx.datacenterName = data.toString();
        assert.string(ctx.datacenterName, 'ctx.datacenterName');

        callback();
    });
}

function getNetAgentInstanceId(opts, callback) {
    assert.object(opts, 'opts');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');

    var instance_root = path.join(
        SERVER_ROOT,
        opts.serverUuid,
        'agent_instances');
    var net_agent_instance_file = path.join(instance_root, 'net-agent');

    fs.mkdir(instance_root, function _onMkdir(err) {
        // check for EEXIST, then ignore err
        if (err && err.code !== 'EEXIST') {
            callback(err);
            return;
        }

        fs.readFile(net_agent_instance_file, function onData(err, data) {
            var instanceUuid;

            if (err) {
                if (err.code !== 'ENOENT') {
                    callback(err);
                    return;
                }

                instanceUuid = uuidv4();
                fs.writeFile(net_agent_instance_file, instanceUuid,
                    function _onWrite(err) {

                    assert.ifError(err);

                    callback(null, instanceUuid);
                });
                return;
            }

            instanceUuid = data.toString();
            callback(null, instanceUuid);
        });
    });
}

function runServer(opts, callback) {
    var config = {};
    var ctx = opts.ctx;
    var fullDNS = ctx.datacenterName + '.' + ctx.dnsDomain;

    // First we need to build a config for this net-agent

    loadSysinfo(opts.serverUuid, function _onSysinfo(err, sysinfo) {
        assert.ifError(err);

        config.admin_uuid = ctx.ufdsAdminUuid;
        config.bindip = ctx.bindIP;
        config.cn_uuid = opts.serverUuid;
        config.cueballAgent = {
            resolvers: [ 'binder.' + fullDNS ],
            initialDomains: [ 'napi.' + fullDNS ],
            spares: 3,
            maximum: 10,
            recovery: {
                'default': {
                    timeout: 2000,
                    maxTimeout: 8000,
                    retries: 3,
                    delay: 0,
                    maxDelay: 1000
                }
            }
        };
        config.datacenterName = ctx.datacenterName;
        config.dnsDomain = ctx.dnsDomain;
        config.log = opts.log;
        config.napi = {
            url: 'http://napi.' + fullDNS
        };
        config.no_rabbit = true;
        config.sysinfo = sysinfo;

        // Create a new vmadm just for this server
        config.vmadm = new DummyVmadm({
            log: opts.log,
            serverRoot: SERVER_ROOT,
            sysinfo: sysinfo,
            uuid: opts.serverUuid
        });

        getNetAgentInstanceId({
            serverUuid: opts.serverUuid
        }, function _onInstanceId(err, instanceUuid) {
            var netagent;

            assert.ifError(err);
            config.agent_uuid = instanceUuid;

            netagent = new NetAgent(config);
            netagent.start();

            callback();
        });
    });
}

function main() {
    fs.readdir(SERVER_ROOT, function _onReadDir(err, dirs) {
        var state = {};

        if (err) {
            console.error('FATAL: %s', err.message);
            process.exit(2);
            return;
        }

        vasync.pipeline({
            arg: state,
            funcs: [
                findDatacenterName,
                findDnsDomain,
                findUfdsAdminUuid,
                findZoneAdminIp
            ]
        }, function pipelineComplete(pipelineErr) {
            assert.ifError(pipelineErr);

            vasync.forEachPipeline({
                func: function _runServer(serverUuid, cb) {
                    assert.uuid(serverUuid, 'serverUuid');
                    runServer({
                        ctx: state,
                        log: logger,
                        serverUuid: serverUuid
                    }, cb);
                },
                inputs: dirs
            }, function _forEachPipelineComplete(forEachPipelineErr) {
                logger.info('startup sequence complete');
            });
        });
    });
}


// kick things off
main();
