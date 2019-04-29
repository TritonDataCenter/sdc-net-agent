/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019 Joyent, Inc.
 */

/*
 * Tests that verify that locally created NICs (headnode NICs, core service
 * zones created before NAPI existed, etc.) are created in NAPI.
 */

'use strict';

var config = require('../lib/config');
var log = require('../lib/log');
var mod_common = require('../lib/common');
var mod_jsprim = require('jsprim');
var mod_net = require('../lib/net');
var mod_nic = require('../lib/nic');
var mod_vmadm = require('vmadm');
var test = require('tape');

// --- Globals

var SYSINFO = null;
var CN_UUID = config.cn_uuid;
var ADMIN_OWNER = config.admin_uuid;
var ADMIN_TAG = null;
var NETWORK = null;

// --- Setup

test('Setup', function (t) {
    t.plan(2);

    t.test('Get sysinfo', function (t2) {
        mod_common.loadSysinfo(function (err, sysinfo) {
            if (mod_common.ifErr(t2, err, 'load sysinfo')) {
                t2.end();
                return;
            }

            SYSINFO = sysinfo;
            ADMIN_TAG = sysinfo['Admin NIC Tag'] || 'admin';

            t2.ok(sysinfo, 'loaded sysinfo');
            t2.end();
        });
    });

    t.test('Get admin network', function (t2) {
        mod_net.get(t2, {
            params: {
                uuid: 'admin'
            },
            partialExp: {
                name: 'admin'
            }
        }, function (err, net) {
            if (mod_common.ifErr(t2, err, 'get network')) {
                t2.end();
                return;
            }

            NETWORK = net;

            t2.end();
        });
    });
});

// --- Tests

test('Headnode GZ NICs', function (t) {
    t.plan(2);

    var macs = [];

    t.test('Get local NICs', function (t2) {
        var pnics = SYSINFO['Network Interfaces'];
        var vnics = SYSINFO['Virtual Network Interfaces'];

        function pushMAC(_, nic) {
            macs.push({ mac: nic['MAC Address'] });
        }

        mod_jsprim.forEachKey(pnics, pushMAC);
        mod_jsprim.forEachKey(vnics, pushMAC);

        t2.end();
    });

    t.test('Get NAPI NICs', function (t2) {
        t2.notEqual(macs.length, 0, 'loaded nics');

        mod_nic.list(t2, {
            params: {
                belongs_to_type: 'server',
                belongs_to_uuid: CN_UUID,
                owner_uuid: ADMIN_OWNER
            },
            present: macs
        });
    });
});

test('Triton zone NICs', function (t) {
    t.plan(2);

    var macs = [];

    t.test('Get local NICs', function (t2) {
        mod_vmadm.lookup({}, {
            fields: [ 'nics' ],
            log: log
        }, function (err, vms) {
            if (mod_common.ifErr(t2, err, 'list vms')) {
                t2.end();
                return;
            }

            function checkNIC(nic) {
                if (nic.nic_tag === ADMIN_TAG) {
                    t2.equal(nic.network_uuid, NETWORK.uuid,
                        'NIC has backfilled "admin" network_uuid');
                } else {
                    t2.ok(nic.network_uuid,
                        'NIC has backfilled network_uuid');
                }

                macs.push({ mac: nic.mac });
            }

            function checkVM(vm) {
                vm.nics.forEach(checkNIC);
            }

            vms.forEach(checkVM);

            t2.end();
        });
    });

    t.test('Get NAPI NICs', function (t2) {
        t2.notEqual(macs.length, 0, 'loaded nics');

        mod_nic.list(t2, {
            params: {
                belongs_to_type: 'zone',
                cn_uuid: CN_UUID
            },
            present: macs
        });
    });
});
