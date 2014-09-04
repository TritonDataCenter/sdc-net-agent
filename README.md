<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->


# sdc-net-agent

The SDC Networking agent is a library for keeping track of per VM NIC changes on
an SDC data center. There is one Networking agent installed per Compute Node.
NIC changes trigger updates on [NAPI](https://github.com/joyent/sdc-napi) so
data is persisted.

This repository is part of the Joyent SmartDataCenter project (SDC).  For
contribution guidelines, issues, and general documentation, visit the main
[SDC](http://github.com/joyent/sdc) project page.
