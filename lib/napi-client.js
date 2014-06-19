/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * net-agent.js
 */

var async = require('async');
var NAPI = require('sdc-clients').NAPI;

var ANTI_SPOOF_FIELDS = ['allow_dhcp_spoofing', 'allow_ip_spoofing',
    'allow_mac_spoofing', 'allow_restricted_traffic',
    'allow_unfiltered_promisc'];


function NapiClient(options) {
    this.options = options;
    this.log = options.log;

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
 * 3. NIC exists and has to be udpated (update)
 * 4. NIC exists and but has not changed, no need to do anything (noop)
 */
NapiClient.prototype.updateNics = function (vm, nics, callback) {
    var self = this;
    var log = this.log;

    async.forEachSeries(nics, eachNic, callback);

    function eachNic(nic, cb) {
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

            nic.status = (vm.state === 'running' ? 'running' : 'stopped');

            if (!napiNic) {
                self.createNic(vm, nic, cb);
            } else if (_nicChanged(nic, napiNic)) {
                self.updateNic(vm, nic, napiNic, cb);
            } else {
                log.info('NIC (mac=%s, ip=%s, status=%s) unchanged for VM %s',
                    nic.mac, nic.ip, nic.status, vm.uuid);
                cb();
            }
        }
    }
};


NapiClient.prototype.getNic = function (mac, callback) {
    return this.client.getNic(mac, callback);
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

        log.info('NIC (mac=%s, ip=%s, status=%s) added for VM %s',
            nic.mac, nic.ip, nic.status, vm.uuid);
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
            log.error(err, 'Could not udpate NIC %s for VM %s',
                nic.mac, vm.uuid);
            return callback(err);
        }

        log.info('NIC (mac=%s, ip=%s, status=%s) updated for VM %s',
            nic.mac, nic.ip, nic.status, vm.uuid);
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



/*
 * Some helper functions for NapiClient
 */

function _nicChanged(cur, old) {
    var fields = [ 'vlan_id', 'nic_tag', 'primary', 'ip', 'netmask',
        'status' ].concat(ANTI_SPOOF_FIELDS);
    var field;
    var diff = false;

    for (var i = 0; i < fields.length; i++) {
        field = fields[i];
        if (cur[field] !== old[field]) {
            diff = true;
            break;
        }
    }

    return diff;
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
