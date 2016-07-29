/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

var path = require('path');
var fs = require('fs');

var DEFAULT_CFG = path.join(__dirname, '..', '/config.json');
var config = {};
try {
    config = JSON.parse(fs.readFileSync(DEFAULT_CFG, 'utf8'));
} catch (e) {
    console.log('Error reading config');
    console.log(e);
    process.exit(1);
}

/*
 * Constants
 */

var VMAPI_URL = config.vmapi.url || 'http://vmapi.coal-1.joyent.us';
var NAPI_URL = config.napi.url || 'http://napi.coal-1.joyent.us';

var EXTERNAL_NET = undefined;
var VM_UUID = undefined;
/* We use the old sdc-base image from 2014 */
var IMG_UUID = 'de411e86-548d-11e4-a4b7-3bb60478632a';
var OWNER_UUID = undefined;
var SERVER_UUID = undefined;
var VM_NICS = undefined;
var NET_UUID = undefined;

/*
 * Imports and modules
 */

var test = require('tape');
var sdcClients = require('sdc-clients');
var bunyan = require('bunyan');
var VMAPI = new sdcClients.VMAPI({ url: VMAPI_URL });
var NAPI = new sdcClients.NAPI({ url: NAPI_URL });
var vmadm = require('vmadm');
var smf = require('smf');
var restify = require('restify');
var assert = require('assert-plus');

/*
 * Commonly used functions
 */

function delay_check(t, seconds, check) {
    function dcheck() {
        check(function (gone) {
            if (gone) {
                console.log('VM gone');
                t.end();
            } else {
                console.log('VM not gone, waiting');
                setTimeout(dcheck, seconds * 1000);
            }
        });
    }
    dcheck();
}

function check_vm_gone(cb) {
    searchOpts = { uuid: VM_UUID, state: 'active' };
    VMAPI.listVms(searchOpts, function (err, vms) {
        /* If we can't connect to VMAPI we keep retrying until we can. */
        if (err) {
            cb(false);
            return;
        }
        if (vms.length) {
            cb(false);
        } else {
            cb(true);
        }
    });
}


/*
 * Functions for manipulating the net-agent service.
 */

function disable_net_agent(t) {
    smf.svcadm('disable', 'net-agent', { wait: true }, function (err, code) {
        if (err) {
            t.error(err, 'Could not disable net-agent');
            t.end();
            return;
        }
        t.ok(true, 'Disabled net-agent');
        t.end();
    });
}

function enable_net_agent(t) {
    smf.svcadm('enable', 'net-agent', { wait: true }, function (err, code) {
        if (err) {
            t.error(err, 'Could not enable net-agent');
            t.end();
            return;
        }
        t.ok(true, 'Enabled net-agent');
        t.end();
    });
}

function early_exit(err) {
    console.log('A test has failed, so there is no point in continuing.');
    console.log('Subsequent tests were not executed.');
    console.log('Identify the cause of the test failure and fix it.');
    console.log('Then retry running this test suite.');
    if (err) {
        console.log(err);
        console.log(err.stack);
    }
    process.exit(1);
}

/*
 * Functions for checking if nic is present or absent on the system.
 */

function nic_gone(t) {
    NAPI.getNics(VM_UUID, {}, function (err, nics) {
        if (err) {
            t.error(err, 'Error Getting NIC List');
            t.end();
            early_exit(err);
            return;
        }
        if (nics.length > 0) {
            t.ok(false, 'NIC is still here!');
            t.end();
            early_exit();
            return;
        }
        t.ok(true, 'NIC is gone.');
        t.end();
    });
}

function nic_exists(t) {
    NAPI.getNics(VM_UUID, {}, function (err, nics) {
        if (err) {
            t.error(err, 'Error on Getting VM Net Info');
            t.end();
            early_exit(err);
            return;
        }
        VM_NICS = nics;
        if (VM_NICS.length > 0) {
            NET_UUID = VM_NICS[0].network_uuid;
            t.end();
        } else {
            t.ok(false, 'No Nics Found For VM');
            t.end();
            early_exit();
        }
    });
}


function add_incpl_nic(t) {
    var nic = {
        belongs_to_uuid: VM_UUID,
        belongs_to_type: 'zone',
        owner_uuid: OWNER_UUID,
        network_uuid: NET_UUID
    };
    NAPI.provisionNic(NET_UUID, nic, function (err, res) {
        if (err) {
            t.ok(false, 'Error provisioning incomplete NIC!');
            early_exit(err);
            return;
        }
        VMAPI.addNics({uuid: VM_UUID, owner_uuid: OWNER_UUID, macs: [res.mac]},
            function (err2, res2) {
                if (err2) {
                    t.ok(false, 'Error adding incomplete NIC!');
                    early_exit(err2);
                    return;
                }
                console.log('Added Nic to VM');
                t.end();
            });
        return;
    });
}

function check_nic_members(t) {
    NAPI.getNics(VM_UUID, {}, function (err, nics) {
        if (err) {
            t.error(err, 'Error on Getting VM Net Info');
            t.end();
            early_exit(err);
            return;
        }
        VM_NICS = nics;

        if (VM_NICS.length > 0) {
            VM_NICS.forEach(function (nic) {
                t.ok(nic.cn_uuid, 'NIC cn_uuid is defined');
                t.strictEquals(nic.state, 'running');
            });
            t.end();
            return;
        }
        t.ok(false, 'No Nics Found For VM');
        t.end();
        early_exit();
    });
}

/*
 * Functions for creating/destroying VMs
 */

function create_vm(t) {
    VMAPI.createVmAndWait({
        owner_uuid: OWNER_UUID,
        server_uuid: SERVER_UUID,
        networks: [
            {
                ipv4_uuid: EXTERNAL_NET.uuid,
                ipv4_count: 1,
                primary: true
            }
        ],
        brand: 'joyent-minimal',
        ram: 256,
        cpu_cap: 300,
        alias: 'net-agent-test-vm-1',
        image_uuid: IMG_UUID
    }, function createVmCb(err, job) {
        if (err) {
            t.error(err, 'Error on creating VM');
            t.end();
            early_exit(err);
            return;
        }
        VM_UUID = job.vm_uuid;
        console.log('Created VM ' + VM_UUID);
        t.end();
    });
};

function destroy_vm(t) {
    console.log('Destroying VM ' + VM_UUID);
    vmadm.delete({
        uuid: VM_UUID,
        log: bunyan.createLogger({
            name: 'vmadm.delete',
            level: 'DEBUG',
            stream: process.stdout,
            serializers: bunyan.stdSerializers
        })
    }, function (err) {
        if (err) {
            t.error(err, 'Error Deleting With `vmadm`');
            t.end();
            early_exit(err);
            return;
        }
        t.end();
    });
}

function wait_until_agent_ready(t) {
    var client = restify.createJsonClient({
        url: 'http://localhost:5311'
    });

    function try_get_status() {
        client.get({ path: '/status' }, function (err, req, res, obj) {
            if (err) {
                console.log('Error getting status, retrying...');
                console.log(err);
                try_get_status();
                return;
            }
            console.log('status object:');
            console.log(obj);
            var state = obj.init_history.pop().h_name;
            if (state === 'StartedReapNics') {
                console.log('net-agent has started up completely');
                t.end();
            } else if (state === 'SkippedReapNics') {
                console.log('WARNING: net-agent cannot reap NICs');
                console.log('WARNING: try updating NAPI to complete the' +
                    ' nic-reap test');
                early_exit();
                t.end();
            } else {
                console.log('Retrying in 5 seconds');
                setTimeout(function () {
                    try_get_status();
                }, 5 * 1000);
            }
        });
    }
    try_get_status();
}

/*
 * This function asserts that the agent is online. If the agent is not online,
 * it will wait for it to either move into the online state, or into a
 * maintenance or degraded state. If the latter occurs, this function causes
 * the test to abort (in the hope that the dev will fix the service before
 * running this test again).
 */
function assert_svc_state(t) {
    function wait_for_state() {
        var fmri = 'svc:/smartdc/agent/net-agent:default';
        smf.svcs(fmri, function (err, svc) {
            if (svc.state === 'disabled') {
                /* enable svc */
                enable_net_agent(t);
            } else if (svc.state === 'maintenance' || svc.state === 'degraded') {
                /* bail out */
                console.log('net-agent is in ' + svc.state + ' state; bailing.');
                early_exit();
                t.end();
            } else if (svc.state === 'offline' || svc.state === 'unitialized') {
                /* wait for state chage */
                setTimeout(function () {
                    wait_for_state();
                }, 5 * 1000);
            } else {
                t.end();
            }
        });
    }
    wait_for_state();
}

/*
 * The actual tests.
 */

test('Is Net Agent Running?', function (t) {
    assert_svc_state(t);
});

test('Get Network Info', function (t) {
    NAPI.listNetworks(function (err, nets) {
        if (err) {
            t.error(err, 'Could not get network info.');
            t.end();
            early_exit(err);
            return;
        }
        nets.forEach(function (n) {
            assert.string(n.name);
            if (n.name === 'external') {
                EXTERNAL_NET = n;
            }
        });
        t.end();
    });
});

/*
 * We use the same OWNER_UUID that is attributed to the napi0 zone.
 */
test('Get Owner And Server UUIDs', function (t) {
    VMAPI.listVms({alias: 'napi0', state: 'active'}, function (err, vms) {
        if (err) {
            t.error(err, 'Error getting owner UUID');
            t.end();
            early_exit(err);
            return;
        }
        if (vms.length === 1) {
            OWNER_UUID = vms[0].owner_uuid;
            SERVER_UUID = vms[0].server_uuid;
        } else {
            t.error('vms[] array not expected size. Expected size is 1.');
            t.error('Actual size is ' + vms.length);
            early_exit();
        }
        t.end();
    });
});


/*
 * This group of tests verifies that net-agent reacts to VM-events properly.
 */
test('Create VM w/ Vmapi', create_vm);
test('Get VM Net Info', nic_exists);
test('Destroy VM w/ Vmadm', destroy_vm);
test('WAIT', function (t) {
    delay_check(t, 10, check_vm_gone);
});
test('Give Agent Some Time', function (t) {
    setTimeout(function () {
        t.end();
    }, 20 * 1000);
});
test('Verify That NIC Is Gone', nic_gone);

/*
 * This group of tests verifies that net-agent reaps orphaned NICs if it wasn't
 * able to react to the VM-events.
 */
test('Create VM w/ Vmapi', create_vm);
test('Check net-agent Not in Maintenance', assert_svc_state);
test('Disable Net-Agent Service', disable_net_agent);
test('Get VM Net Info', nic_exists);
test('Destroy VM w/ Vmadm', destroy_vm);
test('WAIT', function (t) {
    delay_check(t, 10, check_vm_gone);
});
test('Enable Net-Agent Service', enable_net_agent);
test('Check net-agent Not in Maintenance', assert_svc_state);
test('Wait Till Agent Ready', wait_until_agent_ready);
test('Give Agent Some Time', function (t) {
    setTimeout(function () {
        t.end();
    }, 20 * 1000);
});
test('Verify That NIC Is Gone', nic_gone);

/*
 * This group of tests, will create a VM, disable net-agent, create and add a
 * NIC to the VM that has no cn_uuid and a provisioning state, so that the
 * cn_uuid is undefined and the state is set to 'provisioning'. We then
 * re-enable net-agent, wait for the reap to begin, and verify that after the
 * reap the NIC still exists and has a new cn_uuid and its state is running.
 */
test('Create VM w/ Vmapi', create_vm);
test('Check net-agent Not in Maintenance', assert_svc_state);
test('Disable Net-Agent Service', disable_net_agent);
test('Add Incomplete NIC to NAPI', add_incpl_nic);
test('Enable Net-Agent Service', enable_net_agent);
test('Check net-agent Not in Maintenance', assert_svc_state);
test('Wait Till Agent Ready', wait_until_agent_ready);
test('Give Agent Time To Complete Reap', function (t) {
    setTimeout(function () {
        t.end();
    }, 20 * 1000);
});
test('Verify NIC `cn_uuid` and `state`', check_nic_members);
test('Destroy VM w/ Vmadm', destroy_vm);
test('WAIT', function (t) {
    delay_check(t, 10, check_vm_gone);
});
test('Give Agent Time To Complete Reap', function (t) {
    setTimeout(function () {
        t.end();
    }, 20 * 1000);
});
test('Verify That NIC Is Gone', nic_gone);

/* Node will keep running unless we delete the VMAPI and NAPI objects */
test('Finish', function (t) {
    delete VMAPI;
    delete NAPI;
    t.end();
});
