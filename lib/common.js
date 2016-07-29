/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */
var assert = require('assert-plus');
var VError = require('verror');

function assertStrictOptions(funcname, opts, expected)
{
    assert.string(funcname, 'funcname');
    assert.object(opts, funcname + ': opts');
    assert.object(expected, funcname + ': expected');

    var unexpected = [];
    for (var k in opts) {
        if (!opts.hasOwnProperty(k)) {
            continue;
        }
        var e = expected[k];
        if (!e) {
            unexpected.push(k);
            continue;
        }
        var afunc = assert[e];
        assert.func(afunc, 'invalid assertion type: ' + e);
        afunc(opts[k], 'opts.' + k);
    }

    if (unexpected.length > 0) {
        throw (new VError(funcname + ': unexpected options: ' +
            unexpected.join(', ')));
    }
}

module.exports = {
    assertStrictOptions: assertStrictOptions
};
