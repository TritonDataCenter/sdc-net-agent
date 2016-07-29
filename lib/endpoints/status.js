/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2016 Joyent, Inc.
 */

var mod_jsprim = require('jsprim');

/*
 * Status endpoint
 */



/*
 * GET /status
 */
function
getStatus(req, res, next)
{
    var stat = {
        now: mod_jsprim.hrtimeMicrosec(process.hrtime(req.app.na_epoch)),
        init_history: req.app.na_init_history
    };
    res.send(200, stat);
    next();
}

function
register(http, before)
{
    http.get({
        path: '/status',
        name: 'getStatus'
    }, before, getStatus);
}

module.exports = {
    register: register
};
