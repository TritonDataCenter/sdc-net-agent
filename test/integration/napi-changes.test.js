/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019 Joyent, Inc.
 */

/*
 * Tests that verify that NIC changes made in NAPI are reflected locally.
 */

'use strict';

var config = require('../lib/config');
var log = require('../lib/log');
var mod_common = require('../lib/common');
var mod_forkexec = require('forkexec');
var mod_jsprim = require('jsprim');
var mod_net = require('../lib/net');
var mod_nic = require('../lib/nic');
var mod_uuid = require('uuid');
var mod_vm = require('../lib/vm');
var mod_vmadm = require('vmadm');
var test = require('tape');

// --- Globals

var NAPI_TO_LOCAL_DELAY = 4000;
var LOCAL_TO_NAPI_DELAY = 6000;

var IMGADM = '/usr/sbin/imgadm';
var IMAGE_SOURCE = 'https://images.joyent.com';
var IMAGE_UUID = '915b500a-f147-11e7-a700-cfbbcabe6055';

var FAKE_UUID = '00000000-dead-beef-badd-cafe00000000';

var MTU = 1500;
var NIC_TAG = 'external';
var RESOLVERS1 = [ '8.8.8.8', '8.8.4.4' ];
var RESOLVERS2 = [ '1.1.1.1' ];
var SUBNET = '172.26.7.0/24';
var NETMASK = '255.255.255.0';
var GATEWAY1 = '172.26.7.1';
var GATEWAY2 = '172.26.7.2';

var PROV_START = '172.26.7.3';
var PROV_END = '172.26.7.100';

var IP1 = '172.26.7.7';
var IP2 = '172.26.7.8';
var IP3 = '172.26.7.9';
var CIDR1 = '172.26.7.7/24';
var CIDR2 = '172.26.7.8/24';
var CIDR3 = '172.26.7.9/24';

var INTERFACE1 = 'net0';
var INTERFACE2 = 'net1';
var INTERFACE3 = 'net2';
var MAC1 = mod_common.randomMAC();
var MAC2 = mod_common.randomMAC();
var MAC3 = mod_common.randomMAC();

var NET = null;
var USER1 = mod_uuid.v4();
var USER2 = mod_uuid.v4();
var VM = null;


// --- Helpers

function createNIC(fields) {
    return mod_jsprim.mergeObjects({
        mac: MAC1,
        interface: INTERFACE1,
        nic_tag: NIC_TAG,
        vlan_id: 0,
        mtu: MTU,
        ip: IP1,
        ips: [ CIDR1 ],
        netmask: NETMASK,
        gateway: GATEWAY1,
        gateways: [ GATEWAY1 ],
        network_uuid: NET.uuid
    }, fields);
}


// --- Setup

test('Setup', function (t) {
    t.plan(4);

    t.test('Import test image', function (t2) {
        mod_forkexec.forkExecWait({
            argv: [ IMGADM, 'import', IMAGE_UUID, '-S', IMAGE_SOURCE ],
            includeStderr: true,
            timeout: 0
        }, function (err) {
            t2.ifErr(err, 'image imported');
            t2.end();
        });
    });

    t.test('Clean up previous test network', function (t2) {
        mod_net.list(t2, {
            params: {
                name: 'net-agent-test'
            }
        }, function (err, nets) {
            if (err || nets.length === 0) {
                t2.end();
                return;
            }

            mod_net.del(t2, { uuid: nets[0].uuid });
        });
    });

    t.test('Clean up previous test VM', function (t2) {
        mod_vmadm.lookup({ alias: 'net-agent-test' }, {
            fields: [ 'uuid' ],
            log: log
        }, function (err, vms) {
            if (err || vms.length === 0) {
                t2.end();
                return;
            }

            mod_vm.del(t2, { uuid: vms[0].uuid });
        });
    });

    t.test('Create test network', function (t2) {
        mod_net.create(t2, {
            params: {
                name: 'net-agent-test',
                owner_uuids: [ USER1 ],
                subnet: SUBNET,
                gateway: GATEWAY1,
                provision_start_ip: PROV_START,
                provision_end_ip: PROV_END,
                nic_tag: NIC_TAG,
                vlan_id: 0,
                mtu: MTU,
                resolvers: RESOLVERS1
            },
            partialExp: {
                name: 'net-agent-test',
                owner_uuids: [ USER1 ],
                subnet: SUBNET,
                gateway: GATEWAY1,
                resolvers: RESOLVERS1
            }
        }, function (err, net) {
            if (mod_common.ifErr(t2, err, 'create network')) {
                t2.end();
                return;
            }

            NET = net;

            t2.end();
        });
    });
});


// --- Tests

test('Create VM', function (t) {
    t.test('Create', function (t2) {
        mod_vm.createAndGet(t2, {
            params: {
                owner_uuid: USER1,
                brand: 'joyent-minimal',
                image_uuid: IMAGE_UUID,
                alias: 'net-agent-test',
                hostname: 'net-agent-test',
                max_physical_memory: 512,
                quota: 10,
                resolvers: RESOLVERS1,
                nics: [
                    {
                        mac: MAC1,
                        interface: INTERFACE1,
                        nic_tag: NIC_TAG,
                        vlan_id: 0,
                        ips: [ CIDR1 ],
                        gateways: [ GATEWAY1 ]
                    }
                ]
            },
            partialExp: {
                owner_uuid: USER1,
                nics: [
                    createNIC({
                        mac: MAC1,
                        interface: INTERFACE1,
                        primary: true,
                        nic_tag: NIC_TAG,
                        ip: IP1,
                        ips: [ CIDR1 ],
                        netmask: NETMASK,
                        gateway: GATEWAY1,
                        gateways: [ GATEWAY1 ]
                    })
                ]
            },
            delay: NAPI_TO_LOCAL_DELAY
        }, function (err, vm) {
            if (mod_common.ifErr(t2, err, 'create vm')) {
                t2.end();
                return;
            }

            VM = vm;

            t2.end();
        });
    });

    t.test('Verify remote', function (t2) {
        mod_nic.get(t2, {
            mac: VM.nics[0].mac,
            partialExp: {
                belongs_to_type: 'zone',
                belongs_to_uuid: VM.uuid,
                owner_uuid: USER1,
                cn_uuid: config.cn_uuid,
                state: 'running',
                network_uuid: NET.uuid,
                nic_tag: NET.nic_tag,
                ip: IP1
            }
        });
    });

    t.test('Verify local', function (t2) {
        /*
         * net-agent should have noticed that the local NIC is missing
         * information like "network_uuid", and should have updated the
         * NIC to include it.
         */
        mod_vm.get(t2, {
            uuid: VM.uuid,
            partialExp: {
                resolvers: RESOLVERS1,
                nics: [
                    createNIC({
                        primary: true,
                        ip: IP1,
                        ips: [ CIDR1 ]
                    })
                ]
            }
        });
    });
});

test('NIC: Update spoofing properties', function (t) {
    t.plan(2);

    t.test('Update NAPI', function (t2) {
        mod_nic.update(t2, {
            mac: MAC1,
            params: {
                allow_ip_spoofing: true,
                allow_mac_spoofing: true
            },
            partialExp: {
                allow_ip_spoofing: true,
                allow_mac_spoofing: true
            },
            delay: NAPI_TO_LOCAL_DELAY
        });
    });

    t.test('Verify', function (t2) {
        mod_vm.get(t2, {
            uuid: VM.uuid,
            partialExp: {
                resolvers: RESOLVERS1,
                nics: [
                    createNIC({
                        primary: true,
                        ip: IP1,
                        ips: [ CIDR1 ],
                        allow_ip_spoofing: true,
                        allow_mac_spoofing: true
                    })
                ]
            }
        });
    });
});

test('Network: Update gateway', function (t) {
    t.plan(2);

    t.test('Update', function (t2) {
        mod_net.update(t2, {
            params: {
                uuid: NET.uuid,
                gateway: GATEWAY2
            },
            partialExp: {
                gateway: GATEWAY2
            },
            delay: NAPI_TO_LOCAL_DELAY
        });
    });

    t.test('Verify', function (t2) {
        mod_vm.get(t2, {
            uuid: VM.uuid,
            partialExp: {
                resolvers: RESOLVERS1,
                nics: [
                    createNIC({
                        primary: true,
                        ip: IP1,
                        ips: [ CIDR1 ],
                        allow_ip_spoofing: true,
                        allow_mac_spoofing: true,
                        gateway: GATEWAY2,
                        gateways: [ GATEWAY2 ]
                    })
                ]
            }
        });
    });
});

test('Network: Update resolvers', function (t) {
    t.plan(2);

    t.test('Update', function (t2) {
        mod_net.update(t2, {
            params: {
                uuid: NET.uuid,
                resolvers: RESOLVERS2
            },
            partialExp: {
                resolvers: RESOLVERS2
            },
            delay: NAPI_TO_LOCAL_DELAY
        });
    });

    t.test('Verify', function (t2) {
        mod_vm.get(t2, {
            uuid: VM.uuid,
            partialExp: {
                resolvers: RESOLVERS2,
                nics: [
                    createNIC({
                        primary: true,
                        ip: IP1,
                        ips: [ CIDR1 ],
                        allow_ip_spoofing: true,
                        allow_mac_spoofing: true,
                        gateway: GATEWAY2,
                        gateways: [ GATEWAY2 ]
                    })
                ]
            }
        });
    });
});

test('Network: Update routes', function (t) {
    t.plan(2);

    t.test('Update', function (t2) {
        mod_net.update(t2, {
            params: {
                uuid: NET.uuid,
                routes: {
                    '10.1.2.0/24': '172.26.7.170'
                }
            },
            partialExp: {
                routes: {
                    '10.1.2.0/24': '172.26.7.170'
                }
            },
            delay: NAPI_TO_LOCAL_DELAY
        });
    });

    t.test('Verify', function (t2) {
        mod_vm.get(t2, {
            uuid: VM.uuid,
            partialExp: {
                routes: {
                    '10.1.2.0/24': '172.26.7.170'
                }
            }
        });
    });
});

test('Stopping VM updates NIC state', function (t) {
    t.plan(3);

    t.test('Verify before', function (t2) {
        mod_nic.get(t2, {
            mac: MAC1,
            partialExp: {
                state: 'running'
            }
        });
    });

    t.test('Stop VM', function (t2) {
        mod_vm.stop(t2, {
            uuid: VM.uuid,
            delay: LOCAL_TO_NAPI_DELAY
        });
    });

    t.test('Verify after', function (t2) {
        mod_nic.get(t2, {
            mac: MAC1,
            partialExp: {
                state: 'stopped'
            }
        });
    });
});

test('Incorrect cn_uuid is updated', function (t) {
    t.plan(3);

    t.test('Update NAPI', function (t2) {
        mod_nic.update(t2, {
            mac: MAC1,
            params: {
                cn_uuid: FAKE_UUID
            },
            partialExp: {
                cn_uuid: FAKE_UUID
            }
        });
    });

    t.test('Start VM', function (t2) {
        /*
         * We start the VM again here so that net-agent will push our local
         * state sooner than it would if we waited for the NicFSM to time out
         * and check what's in NAPI.
         */
        mod_vm.start(t2, {
            uuid: VM.uuid,
            delay: LOCAL_TO_NAPI_DELAY
        });
    });

    t.test('Verify', function (t2) {
        mod_nic.get(t2, {
            mac: MAC1,
            partialExp: {
                cn_uuid: config.cn_uuid,
                state: 'running'
            }
        });
    });
});

test('Change owner_uuid', function (t) {
    t.plan(3);

    t.test('Verify before', function (t2) {
        mod_nic.get(t2, {
            mac: MAC1,
            partialExp: {
                owner_uuid: USER1
            }
        });
    });

    t.test('Update VM', function (t2) {
        mod_vm.updateAndGet(t2, {
            uuid: VM.uuid,
            params: {
                owner_uuid: USER2
            },
            partialExp: {
                owner_uuid: USER2
            },
            delay: LOCAL_TO_NAPI_DELAY
        });
    });

    t.test('Verify after', function (t2) {
        mod_nic.get(t2, {
            mac: MAC1,
            partialExp: {
                owner_uuid: USER2
            }
        });
    });
});

test('Adding a new NIC creates it in NAPI', function (t) {
    t.plan(2);

    t.test('Add NIC to VM', function (t2) {
        mod_vm.updateAndGet(t2, {
            uuid: VM.uuid,
            params: {
                add_nics: [ {
                    mac: MAC2,
                    interface: INTERFACE2,
                    nic_tag: NIC_TAG,
                    vlan_id: 0,
                    ips: [ CIDR2 ],
                    gateways: [ GATEWAY2 ]
                } ]
            },
            partialExp: {
                resolvers: RESOLVERS2,
                nics: [
                    createNIC({
                        mac: MAC1,
                        interface: INTERFACE1,
                        primary: true,
                        ip: IP1,
                        ips: [ CIDR1 ],
                        allow_ip_spoofing: true,
                        allow_mac_spoofing: true,
                        gateway: GATEWAY2,
                        gateways: [ GATEWAY2 ]
                    }),
                    createNIC({
                        mac: MAC2,
                        interface: INTERFACE2,
                        ip: IP2,
                        ips: [ CIDR2 ],
                        gateway: GATEWAY2,
                        gateways: [ GATEWAY2 ]
                    })
                ],
                routes: {
                    '10.1.2.0/24': '172.26.7.170'
                }
            },
            delay: LOCAL_TO_NAPI_DELAY
        });
    });

    t.test('Verify after', function (t2) {
        mod_nic.get(t2, {
            mac: MAC2,
            partialExp: {
                belongs_to_type: 'zone',
                belongs_to_uuid: VM.uuid,
                owner_uuid: USER2,
                cn_uuid: config.cn_uuid,
                state: 'running',
                network_uuid: NET.uuid,
                nic_tag: NET.nic_tag,
                ip: IP2
            }
        });
    });
});

test('Change primary NIC', function (t) {
    t.plan(3);

    t.test('Verify before', function (t2) {
        mod_nic.get(t2, {
            mac: MAC1,
            partialExp: {
                primary: true
            }
        });
    });

    t.test('Update VM', function (t2) {
        mod_vm.updateAndGet(t2, {
            uuid: VM.uuid,
            params: {
                add_nics: [ {
                    mac: MAC3,
                    interface: INTERFACE3,
                    nic_tag: NIC_TAG,
                    vlan_id: 0,
                    ips: [ CIDR3 ],
                    gateways: [ GATEWAY2 ],
                    primary: true
                } ]
            },
            partialExp: {
                resolvers: RESOLVERS2,
                nics: [
                    createNIC({
                        mac: MAC1,
                        interface: INTERFACE1,
                        ip: IP1,
                        ips: [ CIDR1 ],
                        allow_ip_spoofing: true,
                        allow_mac_spoofing: true,
                        gateway: GATEWAY2,
                        gateways: [ GATEWAY2 ]
                    }),
                    createNIC({
                        mac: MAC2,
                        interface: INTERFACE2,
                        ip: IP2,
                        ips: [ CIDR2 ],
                        gateway: GATEWAY2,
                        gateways: [ GATEWAY2 ]
                    }),
                    createNIC({
                        mac: MAC3,
                        interface: INTERFACE3,
                        primary: true,
                        ip: IP3,
                        ips: [ CIDR3 ],
                        gateway: GATEWAY2,
                        gateways: [ GATEWAY2 ]
                    })
                ],
                routes: {
                    '10.1.2.0/24': '172.26.7.170'
                }
            },
            delay: LOCAL_TO_NAPI_DELAY
        });
    });

    t.test('Verify after', function (t2) {
        mod_nic.get(t2, {
            mac: MAC3,
            partialExp: {
                belongs_to_type: 'zone',
                belongs_to_uuid: VM.uuid,
                owner_uuid: USER2,
                cn_uuid: config.cn_uuid,
                state: 'running',
                network_uuid: NET.uuid,
                nic_tag: NET.nic_tag,
                primary: true,
                ip: IP3
            }
        });
    });
});

test('Removing NIC from VM removes it from NAPI', function (t) {
    t.plan(2);

    t.test('Remove NIC from VM', function (t2) {
        mod_vm.updateAndGet(t2, {
            uuid: VM.uuid,
            params: {
                remove_nics: [ MAC2 ]
            },
            partialExp: {
                nics: [
                    createNIC({
                        mac: MAC1,
                        interface: INTERFACE1,
                        ip: IP1,
                        ips: [ CIDR1 ],
                        allow_ip_spoofing: true,
                        allow_mac_spoofing: true,
                        gateway: GATEWAY2,
                        gateways: [ GATEWAY2 ]
                    }),
                    createNIC({
                        mac: MAC3,
                        interface: INTERFACE3,
                        primary: true,
                        ip: IP3,
                        ips: [ CIDR3 ],
                        gateway: GATEWAY2,
                        gateways: [ GATEWAY2 ]
                    })
                ]
            },
            delay: LOCAL_TO_NAPI_DELAY
        });
    });

    t.test('Verify NIC is gone', function (t2) {
        mod_nic.get(t2, {
            mac: MAC2,
            expCode: 404,
            expErr: {
                code: 'ResourceNotFound',
                message: 'nic not found'
            }
        });
    });
});

test('Removing NIC from NAPI removes it from VM', function (t) {
    t.plan(2);

    t.test('Remove NIC from NAPI', function (t2) {
        mod_nic.del(t2, {
            mac: MAC3,
            delay: NAPI_TO_LOCAL_DELAY
        });
    });

    t.test('Verify VM', function (t2) {
        mod_vm.get(t2, {
            uuid: VM.uuid,
            partialExp: {
                nics: [
                    createNIC({
                        mac: MAC1,
                        interface: INTERFACE1,
                        primary: true,
                        ip: IP1,
                        ips: [ CIDR1 ],
                        allow_ip_spoofing: true,
                        allow_mac_spoofing: true,
                        gateway: GATEWAY2,
                        gateways: [ GATEWAY2 ]
                    })
                ]
            }
        });
    });
});

test('Deleting VM deletes NIC from NAPI', function (t) {
    t.test('Delete VM', function (t2) {
        mod_vm.del(t2, {
            uuid: VM.uuid,
            delay: LOCAL_TO_NAPI_DELAY
        });
    });

    t.test('Verify NIC is gone', function (t2) {
        mod_nic.get(t2, {
            mac: MAC1,
            expCode: 404,
            expErr: {
                code: 'ResourceNotFound',
                message: 'nic not found'
            }
        });
    });
});
