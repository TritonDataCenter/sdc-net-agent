/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019 Joyent, Inc.
 */

'use strict';

/*
 * Get monotonic time in milliseconds.
 *
 * Note that this is *not* the same as Date.now(), which returns the current
 * wall clock time in milliseconds.
 */
function currentMillis() {
    var time = process.hrtime();
    var secs2ms = time[0] * 1000;
    var ns2ms = time[1] / 1000000;

    return (secs2ms + ns2ms);
}


module.exports = {
    currentMillis: currentMillis
};
