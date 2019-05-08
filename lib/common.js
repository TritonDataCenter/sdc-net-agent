/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018 Joyent, Inc.
 */

'use strict';

var assert = require('assert-plus');
var mod_jsprim = require('jsprim');
var mod_util = require('util');

// --- Exports

function formatAggrId(cn_uuid, name) {
    assert.uuid(cn_uuid, 'cn_uuid');
    assert.string(name, 'name');

    return mod_util.format('%s-%s', cn_uuid, name);
}


function hasChanged(fields, cur, old) {
    if (cur === old) {
        return false;
    }

    if (old === null) {
        return true;
    }

    return fields.some(function (field) {
        return !mod_jsprim.deepEqual(cur[field], old[field]);
    });
}


module.exports = {
    formatAggrId: formatAggrId,
    hasChanged: hasChanged
};
