#!/bin/bash

export SMFDIR=$npm_config_smfdir

if svcs heartbeater; then
svcadm disable -s heartbeater
svccfg delete heartbeater
fi

rm -f "$SMFDIR/heartbeater.xml"
