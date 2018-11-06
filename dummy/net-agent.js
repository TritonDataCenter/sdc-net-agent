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
var DummyVmadm = require('vmadm/lib/index.dummy_vminfod');
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

    logger.debug({server_uuid: server_uuid},
        'loading sysinfo for dummy server');

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


// TODO These next 2 functions should probably eventually go in a common library
//      for mockcloud agents to use.

function _mkdirP(dir, callback) {
    fs.mkdir(dir, function _onMkdir(err) {
        // only return when error is not EEXIST (which is fine)
        if (err && err.code !== 'EEXIST') {
            callback(err);
            return;
        }

        callback();
    });
}

function getAgentInstanceId(opts, callback) {
    assert.object(opts, 'opts');
    assert.string(opts.agentName, 'opts.agentName');
    assert.uuid(opts.serverUuid, 'opts.serverUuid');

    var agent_dir;
    var agents_dir = path.join(SERVER_ROOT, opts.serverUuid, 'agents');
    var agent_inst_file;
    var instanceUuid;

    agent_dir = path.join(agents_dir, opts.agentName);
    agent_inst_file = path.join(agent_dir, 'instance_uuid');

    vasync.pipeline({
        funcs: [
            function mkAgentsDir(_, cb) {
                _mkdirP(agents_dir, cb);
            },
            function mkAgentDir(_, cb) {
                _mkdirP(agent_dir, cb);
            },
            function readInstanceFile(_, cb) {
                fs.readFile(agent_inst_file, function onData(err, data) {
                    if (err) {
                        if (err.code !== 'ENOENT') {
                            cb(err);
                            return;
                        }
                    } else {
                        instanceUuid = data.toString().trim();
                    }

                    cb();
                });
            },
            function writeInstanceFile(_, cb) {
                if (instanceUuid !== undefined) {
                    // already had one when we read above.
                    cb();
                    return;
                }

                instanceUuid = uuidv4();
                fs.writeFile(agent_inst_file, instanceUuid + '\n', cb);
            }
        ]
    }, function _onPipeline(err) {
        callback(err, instanceUuid);
    });
}

function getNetAgentInstanceId(opts, callback) {
    opts.agentName = 'net-agent';
    getAgentInstanceId(opts, callback);
}

function runServer(opts, callback) {
    var ctx = opts.ctx;
    var fullDNS = ctx.datacenterName + '.' + ctx.dnsDomain;

    // First we need to build a config for this net-agent

    loadSysinfo(opts.serverUuid, function _onSysinfo(err, sysinfo) {
        assert.ifError(err);

        var config = {};

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
        config.loadSysinfo = function _loadSysinfo(cb) {
            loadSysinfo(config.cn_uuid, cb);
        };
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
