#!/bin/bash

set -o xtrace
DIR=`dirname $0`

export PREFIX=$npm_config_prefix
export ETC_DIR=$npm_config_etc
export SMF_DIR=$npm_config_smfdir
export VERSION=$npm_package_version

. /lib/sdc/config.sh
load_sdc_config

AGENT=$npm_package_name
SAPI_URL=http://${CONFIG_sapi_domain}

function fatal()
{
    echo "error: $*" >&2
    exit 1
}

function subfile()
{
  IN=$1
  OUT=$2
  sed -e "s#@@PREFIX@@#$PREFIX#g" \
      -e "s/@@VERSION@@/$VERSION/g" \
      $IN > $OUT
}

function instance_exists()
{
    local instance_uuid=$1
    local sapi_instance=$(curl ${SAPI_URL}/instances/${instance_uuid} | json -H uuid)

    if [[ -n ${sapi_instance} ]]; then
        return 0
    else
        return 1
    fi
}

function get_adopt_instance()
{
    local instance_uuid=$(cat $ETC_DIR/$AGENT)

    # verify it exists on sapi if there is an instance uuid written to disk
    if [[ -n ${instance_uuid} ]]; then
        if ! instance_exists "$instance_uuid"; then
            adopt_instance $instance_uuid
        fi
    else
        adopt_instance $(uuid -v4)
    fi
}

function adopt_instance()
{
    local instance_uuid=$1
    echo $instance_uuid > $ETC_DIR/$AGENT

    local service_uuid=""
    local sapi_instance=""
    local i=0

    while [[ -z ${service_uuid} && ${i} -lt 48 ]]; do
        service_uuid=$(curl "${SAPI_URL}/services?type=agent&name=${AGENT}"\
            -sS -H accept:application/json | json -Ha uuid)
        if [[ -z ${service_uuid} ]]; then
            echo "Unable to get server_uuid from sapi yet.  Sleeping..."
            sleep 5
        fi
        i=$((${i} + 1))
    done
    [[ -n ${service_uuid} ]] || \
    fatal "Unable to get service_uuid for role ${AGENT} from SAPI"

    i=0
    while [[ -z ${sapi_instance} && ${i} -lt 48 ]]; do
        sapi_instance=$(curl ${SAPI_URL}/instances -sS -X POST \
            -H content-type:application/json \
            -d "{ \"service_uuid\" : \"${service_uuid}\", \"uuid\" : \"${instance_uuid}\" }" \
        | json -H uuid)
        if [[ -z ${sapi_instance} ]]; then
            echo "Unable to adopt ${AGENT} ${instance_uuid} into sapi yet.  Sleeping..."
            sleep 5
        fi
        i=$((${i} + 1))
    done

    [[ -n ${sapi_instance} ]] || fatal "Unable to adopt ${instance_uuid} into SAPI"
    echo "Adopted service ${AGENT} to instance ${instance_uuid}"
}

# Check if we're inside a headnode and if there is a SAPI available. This post-
# install script runs in the following circumstances:
# 1. (don't call adopt) hn=1, sapi=0: first hn boot, disable agent, exit 0
# 2. (call adopt) hn=1, sapi=1: upgrades, run script, get-or-create instance
# 3. (call adopt) hn=0, sapi=0: new cns, cn upgrades, run script, get-or-create instance
# 4. (call adopt) hn=0, sapi=1: no sdc-sapi on CNs, unexpected but possible
is_headnode=$(sysinfo | json "Boot Parameters".headnode)
have_sapi=false

(sdc-sapi /ping)
if [[ $? == 0 ]]; then
	have_sapi="true"
fi

subfile "$DIR/../smf/manifests/$AGENT.xml.in" "$SMF_DIR/$AGENT.xml"
svccfg import $SMF_DIR/$AGENT.xml

# case 1) is first time this agent is installed on the headnode. Disable its
# service until config-agent sets up its config
if [[ $is_headnode == "true" ]] && [[ $have_sapi == "false" ]]; then
    svcadm disable $AGENT
    exit 0
fi

get_adopt_instance

exit 0