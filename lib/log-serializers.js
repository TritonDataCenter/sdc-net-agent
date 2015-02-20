/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

/*
 * agent log serializers
 */

var bunyan = require('bunyan');


var serializers = {};


/*
 * Serialize an error, including extra fields that we may get from our APIs
 * for debugging
 */
function errSerializer(err) {
    var obj = bunyan.stdSerializers.err(err);
    if (!obj) {
        /*jsl:ignore*/
        return;
        /*jsl:end*/
    }

    if (err.body && typeof (err.body) === 'object' && err.body.errors) {
        obj.errors = err.body.errors;
    }

    return obj;
}


for (var s in bunyan.stdSerializers) {
    if (s === 'err') {
        continue;
    }

    serializers[s] = bunyan.stdSerializers[s];
}

serializers.err = errSerializer;

module.exports = serializers;
