/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

/*
 * net-agent.js
 */

var async = require('async');
var NAPI = require('sdc-clients').NAPI;
var assert = require('assert-plus');
var common = require('./common');

var ANTI_SPOOF_FIELDS = ['allow_dhcp_spoofing', 'allow_ip_spoofing',
    'allow_mac_spoofing', 'allow_restricted_traffic',
    'allow_unfiltered_promisc'];


function NapiClient(options) {
    this.options = options;
    this.log = options.log;
    this.uuid = options.uuid;

    this.client = new NAPI({
        url: options.url,
        log: options.log,
        userAgent: options.userAgent
    });
}


/*
 * Updates each of the VM NICs
 *
 * - vm: VM object
 * - nics: the NICs that need to be updated
 *
 * Calls out to NAPI to verify the current NIC data and for each NIC it can do
 * one of the following things:
 *
 * 1. NIC was removed from the VM or VM provision has failed (destroy)
 * 2. NIC doesn't exist and needs to be added (create)
 * 3. NIC exists and has to be updated (update)
 * 4. NIC exists and but has not changed, no need to do anything (noop)
 */
NapiClient.prototype.updateNics = function (vm, nics, callback) {
    var self = this;
    var log = this.log;

    async.forEachSeries(nics, eachNic, callback);

    function eachNic(nic, cb) {
        // cn_uuid is a field that exists in NAPI but not in vmadm, so add
        // it here:
        nic.cn_uuid = self.uuid;

        self.getNic(nic.mac, onGetNic);

        function onGetNic(err, napiNic) {
            if (err) {
                if (err.name === 'ResourceNotFoundError') {
                    napiNic = undefined;
                } else {
                    cb(err);
                    return;
                }
            }

            if (nic.destroyed) {
                self.deleteNic(vm, nic, cb);
                return;
            }

            nic.state = (vm.state === 'running' ? 'running' : 'stopped');

            if (!napiNic) {
                self.createNic(vm, nic, cb);
            } else if (_nicChanged(nic, napiNic)) {
                self.updateNic(vm, nic, napiNic, cb);
            } else {
                log.info('NIC (mac=%s, ip=%s, state=%s) unchanged for VM %s',
                    nic.mac, nic.ip, nic.state, vm.uuid);
                cb();
            }
        }
    }
};


NapiClient.prototype.getNic = function (mac, callback) {
    assert.object(this.client, 'this.client');
    return this.client.getNic(mac, callback);
};


NapiClient.prototype.searchNics = function (params, callback) {
    assert.func(callback, 'callback');
    this.client.searchNics(params, callback);
};


NapiClient.prototype.createNic = function (vm, newNic, callback) {
    var log = this.log;
    var nic = _createNicPayload(vm, newNic);

    this.client.createNic(nic.mac, nic, function (err) {
        if (err) {
            log.error(err, 'Could not add NIC %s for VM %s',
                nic.mac, vm.uuid);
            return callback(err);
        }

        log.info('NIC (mac=%s, ip=%s, state=%s) added for VM %s',
            nic.mac, nic.ip, nic.state, vm.uuid);
        return callback();
    });
};


NapiClient.prototype.updateNic = function (vm, newNic, napiNic, callback) {
    var log = this.log;
    var nic = _createNicPayload(vm, newNic);

    for (var i = 0; i < ANTI_SPOOF_FIELDS.length; i++) {
        var field = ANTI_SPOOF_FIELDS[i];
        if (napiNic.hasOwnProperty(field) && !newNic.hasOwnProperty(field)) {
            nic[field] = false;
        }
    }

    this.client.updateNic(nic.mac, nic, function (err) {
        if (err) {
            log.error(err, 'Could not update NIC %s for VM %s',
                nic.mac, vm.uuid);
            return callback(err);
        }

        log.info('NIC (mac=%s, ip=%s, state=%s) updated for VM %s',
            nic.mac, nic.ip, nic.state, vm.uuid);
        return callback();
    });
};


NapiClient.prototype.deleteNic = function (vm, nic, callback) {
    var log = this.log;

    this.client.deleteNic(nic.mac, function (err) {
        if (err) {
            if (err.name === 'ResourceNotFoundError') {
                log.info('NIC (mac=%s, ip=%s) already gone for VM %s',
                    nic.mac, nic.ip, vm.uuid);
                return callback();
            } else {
                log.error(err, 'Could not delete NIC %s for VM %s',
                    nic.mac, vm.uuid);
                return callback(err);
            }
        }

        log.info('NIC (mac=%s, ip=%s) deleted for VM %s',
            nic.mac, nic.ip, vm.uuid);
        return callback();
    });
};


NapiClient.prototype.getNics = function (belongsTo, options, callback) {
    common.assertStrictOptions('getNics', options, {
        headers: 'string'
    });
    this.client.getNics(belongsTo, options, callback);
};



/*
 * Some helper functions for NapiClient
 */

function _nicChanged(cur, old) {
    var fields = [ 'cn_uuid', 'vlan_id', 'nic_tag', 'primary', 'ip', 'netmask',
        'state' ].concat(ANTI_SPOOF_FIELDS);
    var field;

    for (var i = 0; i < fields.length; i++) {
        field = fields[i];
        if (cur[field] !== old[field]) {
            return true;
        }
    }

    return false;
}


function _clone(obj) {
    if (null === obj || 'object' != typeof (obj)) {
        return obj;
    }

    var copy = obj.constructor();

    for (var attr in obj) {
        if (obj.hasOwnProperty(attr)) {
            copy[attr] = obj[attr];
        }
    }
    return copy;
}


function _sanitizeBooleanAntiSpoof(nic) {
    function booleanFromValue(value) {
        if (value === 'false' || value === '0') {
            return false;
        } else if (value === 'true' || value === '1') {
            return true;
        } else {
            // else should be boolean
            return value;
        }
    }

    ANTI_SPOOF_FIELDS.forEach(function (field) {
        if (nic[field] !== undefined) {
            nic[field] = booleanFromValue(nic[field]);
        }
    });
}


function _createNicPayload(vm, currentNic) {
    var newNic = _clone(currentNic);

    newNic.check_owner = false;
    newNic.owner_uuid = vm.owner_uuid;
    newNic.belongs_to_uuid = vm.uuid;
    newNic.belongs_to_type = 'zone';

    if (newNic.vlan_id === undefined) {
        newNic.vlan_id = 0;
    }
    newNic.vlan = newNic.vlan_id;
    _sanitizeBooleanAntiSpoof(newNic);

    return newNic;
}


module.exports = NapiClient;
