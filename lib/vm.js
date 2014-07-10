/*
 * Copyright (c) 2014, Joyent, Inc. All rights reserved.
 *
 * Functions for interacting with vmadm
 */

var execFile = require('child_process').execFile;


var VMADM = '/usr/sbin/vmadm';



function isLocal(vms, vm) {
    for (var v in vms) {
        if (vms[v].uuid == vm.uuid) {
            return vms[v];
        }
    }

    return null;
}


function listVMs(filter, callback) {
    if (!callback) {
        callback = filter;
        filter = {};
    }

    var args = ['lookup', '-j'];
    for (var k in filter) {
        args.push(k + '=' + filter[k]);
    }

    return execFile(VMADM, args, function (err, stdout, stderr) {
        if (err) {
            err.stdout = stdout;
            err.stderr = stderr;
            return callback(err);
        }

        var vms;

        try {
            vms = JSON.parse(stdout);
        } catch (jsonErr) {
            jsonErr.stdout = stdout;
            return callback(jsonErr);
        }

        return callback(null, vms);
    });
}



module.exports = {
    isLocal: isLocal,
    list: listVMs
};