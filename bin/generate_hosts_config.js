#!/usr/bin/env node
// -*- mode: js -*-
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var assert = require('assert-plus');
var bunyan = require('bunyan');
var fs = require('fs');
var getopt = require('posix-getopt');
var path = require('path');
var sdc = require('sdc-clients');
var vasync = require('vasync');

var LOG = bunyan.createLogger({
        'level': (process.env.LOG_LEVEL || 'debug'),
        'name': 'generate_hosts_config',
        'stream': process.stdout,
        'serializers': bunyan.stdSerializers
});



//--- Helpers

function usage(msg) {
        if (msg) {
                console.error(msg);
        }
        var str  = 'usage: ' + path.basename(process.argv[1]);
        str += ' [-a agentNetworkTag]';
        str += ' [-c configFile]';
        str += ' [-f output_file]';
        str += ' [-n mantaNetworkTag]';
        console.error(str);
        process.exit(1);
}

function parseOptions() {
        var option;
        var opts = {
                'dcs': {}
        };
        var parser = new getopt.BasicParser('a:c:f:n:',
                                            process.argv);
        while ((option = parser.getopt()) !== undefined && !option.error) {
                switch (option.option) {
                case 'a':
                        opts.agentNetworkTag = option.optarg;
                        break;
                case 'c':
                        opts.configFile = option.optarg;
                        break;
                case 'f':
                        opts.outputFileName = option.optarg;
                        break;
                case 'n':
                        opts.networkTag = option.optarg;
                        break;
                default:
                        usage('Unknown option: ' + option.option);
                        break;
                }
        }

        // Now set some defaults.
        opts.outputFileName = opts.outputFileName ||
                '/opt/smartdc/madtom/etc/checker-hosts.json';
        opts.agentNetworkTag = opts.agentNetworkTag || 'manta';
        opts.networkTag = opts.networkTag || 'manta';
        opts.configFile = opts.configFile ||
                '/opt/smartdc/madtom/etc/config.json';

        //Load config file and pull what we need out of it...
        try {
                var contents = fs.readFileSync(opts.configFile, 'utf-8');
                var config = JSON.parse(contents);
        } catch (e) {
                usage('Error while reading/parsing config file: ' + e.code);
        }

        if (!config.ufds) {
                usage('Config file didn\'t contain a ufds block.');
        }
        opts.ufdsConfig = config.ufds;

        if (!config.dnsDomain) {
                usage('Config file didn\'t contain a dnsDomain.');
        }
        opts.dnsDomain = config.dnsDomain;

        if (!config.datacenter) {
                usage('Config file didn\'t contain a datacenter.');
        }
        opts.datacenter = config.datacenter;

        if (!config.region) {
                usage('Config file didn\'t contain a region.');
        }
        opts.region = config.region;

        return (opts);
}


function getDcClients(opts, cb) {
        var self = this;
        var clients = {};

        function url(svc) {
                return ('http://' + svc + '.' + opts.dc + '.' + opts.dnsDomain);
        }

        vasync.pipeline({
                'funcs': [
                        function cnapi(_, subcb) {
                                self.log.debug({
                                        'client': 'cnapi',
                                        'dc': opts.dc,
                                        'url': url('cnapi')
                                });
                                clients['CNAPI'] = new sdc.CNAPI({
                                        log: self.log,
                                        url: url('cnapi'),
                                        agent: false
                                });
                                subcb();
                        },
                        function vmapi(_, subcb) {
                                self.log.debug({
                                        'client': 'vmapi',
                                        'dc': opts.dc,
                                        'url': url('vmapi')
                                });
                                clients['VMAPI'] = new sdc.VMAPI({
                                        log: self.log,
                                        url: url('vmapi'),
                                        agent: false
                                });
                                subcb();
                        }
                ]
        }, function (err) {
                cb(err, clients);
        });
}


function setupSingleDcClients(_, cb) {
        var self = this;
        vasync.pipeline({
                'funcs': [
                        function ufds(_2, subcb) {
                                self.log.debug({
                                        'ufdsConfig': self.UFDS_CONFIG
                                }, 'connecting to ufds');

                                self['UFDS'] = new sdc.UFDS(self.UFDS_CONFIG);

                                self['UFDS'].on('ready', function (err) {
                                        self.log.debug({
                                                'ufdsConfig': self.UFDS_CONFIG,
                                                'err': err
                                        }, 'ufds onReady');
                                        return (subcb(err));
                                });
                        },
                        function sapi(_2, subcb) {
                                var url = 'http://sapi.' + self.DATACENTER +
                                        '.' + self.DNS_DOMAIN;
                                self.log.debug({
                                        'client': 'sapi',
                                        'url': url
                                });
                                self['SAPI'] = new sdc.SAPI({
                                        log: self.log,
                                        url: url,
                                        agent: false
                                });
                                subcb();
                        }
                ]
        }, function (err) {
                cb(err);
        });
}


function getDcs(_, cb) {
        var self = this;
        var ufds = self['UFDS'];
        ufds.listDatacenters(self.REGION, function (err, res) {
                if (err) {
                        return (cb(err));
                }
                if (res.length === 0) {
                        self.log.info({
                                res: res,
                                region: self.REGION
                        }, 'ufds listDatacenters result');
                        return (cb(new Error('no datacenters found')));
                }
                var dcs = {};
                res.forEach(function (datacenter) {
                        //Take the first sdc resolver we come across.
                        if (dcs[datacenter.datacenter] === undefined) {
                                dcs[datacenter.datacenter] = {};
                        }
                });
                self['DCS'] = dcs;
                return (cb());
        });
}


function setupXDcClients(_, cb) {
        var self = this;
        var dcs = Object.keys(self.DCS);
        var i = 0;

        function setupNextClient() {
                var dc = dcs[i];
                if (dc === undefined) {
                        return (cb());
                }
                var opts = {
                        'dc': dc,
                        'dnsDomain': self.DNS_DOMAIN
                };
                getDcClients.call(self, opts, function (err, clients) {
                        if (err) {
                                cb(err);
                                return;
                        }
                        self.DCS[dc]['CLIENT'] = clients;
                        ++i;
                        setupNextClient();
                });
        }
        setupNextClient();
}


function findVm(instance, cb) {
        var self = this;
        var uuid = instance.uuid;
        if (!instance.metadata || !instance.metadata.DATACENTER) {
                self.log.error({
                        'instance': instance
                }, 'instance has no DATACENTER');
                return (cb(new Error('instance has no DATACENTER: ' + uuid)));
        }
        var dc = instance.metadata.DATACENTER;
        var vmapi = self.DCS[dc].CLIENT.VMAPI;
        return (vmapi.getVm({ uuid: uuid }, function (err, vm) {
                if (err && err.message === 'socket hang up') {
                        self.log.info({ uuid: uuid, dc: dc },
                                      'socket hangup, trying again');
                        return (findVm.call(self, instance, cb));
                }
                return (cb(err, vm));
        }));
}


function findServer(server, cb) {
        var self = this;
        var dcs = Object.keys(self.DCS);
        vasync.forEachParallel({
                'inputs': dcs.map(function (dc) {
                        return (self.DCS[dc].CLIENT.CNAPI);
                }),
                'func': function (client, subcb) {
                        client.getServer(server, subcb);
                }
        }, function (err, results) {
                if (results.successes.length < 1) {
                        cb(new Error('unable to get server for ' + server));
                        return;
                }
                cb(null, results.successes[0]);
        });
}


function findServerIp(network, server) {
        var ip = null;
        var taggedNic = null;
        var nics = server.sysinfo['Network Interfaces'];
        var nns = Object.keys(nics);
        for (var i = 0; i < nns.length; ++i) {
                var nn = nns[i];
                var nic = nics[nn];
                if (nic['NIC Names'].indexOf(network) !== -1) {
                        ip = nic['ip4addr'];
                        taggedNic = nn;
                        break;
                }
        }

        // If the physical nic doesn't have an ip address, it's probably
        // on a vnic
        if (taggedNic !== null && ip === '') {
                var vnics = server.sysinfo['Virtual Network Interfaces'];
                var labs = Object.keys(vnics);
                for (i = 0; i < labs.length; ++i) {
                        var vnic = vnics[labs[i]];
                        if (vnic['Host Interface'] === taggedNic &&
                            labs[i].indexOf(network) === 0) {
                                ip = vnic.ip4addr;
                                break;
                        }
                }
        }

        return (ip === null || ip === '' ? null : ip);
}



//--- Main

var _self = this;
_self.log = LOG;
var _opts = parseOptions();
_self['OUTPUT_FILENAME'] = _opts.outputFileName;
_self['REGION'] = _opts.region;
_self['DATACENTER'] = _opts.datacenter;
_self['DNS_DOMAIN'] = _opts.dnsDomain;
_self['NETWORK_TAG'] = _opts.networkTag;
_self['AGENT_NETWORK_TAG'] = _opts.agentNetworkTag;
_self['UFDS_CONFIG'] = _opts.ufdsConfig;


_self.log.debug({
        'outputFile': _self['OUTPUT_FILENAME'],
        'region': _self['REGION'],
        'datacenter': _self['DATACENTER'],
        'dnsDomain': _self['DNS_DOMAIN'],
        'networkTag': _self['NETWORK_TAG'],
        'agentNetworkTag': _self['AGENT_NETWORK_TAG'],
        'ufdsConfig': _self['UFDS_CONFIG']
});

vasync.pipeline({
        'funcs': [
                setupSingleDcClients.bind(_self),
                getDcs.bind(_self),
                setupXDcClients.bind(_self),
                function lookupPoseidon(_, subcb) {
                        _self.log.debug({
                                'datacenter': _self['DATACENTER']
                        }, 'connecting to ufds in dc');
                        var ufds = _self.UFDS;
                        ufds.getUser('poseidon', function (err, user) {
                                if (err) {
                                        subcb(err);
                                        return;
                                }
                                _self['POSEIDON'] = user;
                                _self.log.debug({
                                        'uuid': _self['POSEIDON'].uuid
                                }, 'found poseidon');
                                subcb();
                        });
                },
                function lookupMantaApplication(_, subcb) {
                        _self.log.debug({
                                'datacenter': _self['DATACENTER']
                        }, 'connecting to sapi in dc to get manta application');
                        var sapi = _self.SAPI;
                        var search = {
                                'name': 'manta',
                                'owner_uuid':  _self['POSEIDON'].uuid,
                                'include_master': true
                        };
                        sapi.listApplications(search, function (err, apps) {
                                if (err) {
                                        subcb(err);
                                        return;
                                }
                                if (apps.length < 1) {
                                        subcb(new Error('unable to find the ' +
                                                        'manta application'));
                                        return;
                                }
                                _self['MANTA'] = apps[0];
                                _self.log.debug({
                                        'manta': _self['MANTA'].uuid
                                }, 'found the manta application');
                                subcb();
                        });
                },
                function lookupInstances(_, subcb) {
                        _self.log.debug({
                                'datacenter': _self['DATACENTER']
                        }, 'connecting to sapi in dc to lookup instances');
                        var sapi = _self.SAPI;
                        function onr(err, objs) {
                                if (err) {
                                        subcb(err);
                                        return;
                                }

                                _self['SAPI_INSTANCES'] = {};
                                var svcs = Object.keys(objs.instances);
                                for (var i = 0; i < svcs.length; ++i) {
                                        var svc_uuid = svcs[i];
                                        var ins = objs.instances[svc_uuid];
                                        for (var j = 0; j < ins.length; ++j) {
                                                var o = ins[j];
                                                var k = o.uuid;
                                                _self['SAPI_INSTANCES'][k] = o;
                                        }
                                }
                                _self.log.debug({
                                        'instances': Object.keys(
                                                _self['SAPI_INSTANCES']).sort()
                                }, 'found sapi instances');
                                subcb();
                        }

                        var op = {
                                'include_master': true
                        };
                        sapi.getApplicationObjects(_self.MANTA.uuid, op, onr);
                },
                function lookupVms(_, subcb) {
                        _self.log.debug('looking up vms');
                        var inputs = Object.keys(_self['SAPI_INSTANCES']).map(
                                function (k) {
                                        return (_self['SAPI_INSTANCES'][k]);
                                });
                        vasync.forEachParallel({
                                'inputs': inputs,
                                'func': findVm.bind(_self)
                        }, function (err, results) {
                                if (err) {
                                        subcb(err);
                                        return;
                                }
                                _self['VMAPI_VMS'] = {};
                                var opers = results.operations;
                                for (var i = 0; i < opers.length; ++i) {
                                        var uuid = inputs[i].uuid;
                                        var res = opers[i].result;
                                        _self['VMAPI_VMS'][uuid] = res;
                                }
                                _self.log.debug({
                                        'vms': Object.keys(
                                                _self['VMAPI_VMS']).sort()
                                }, 'found vmapi vms');
                                subcb();
                        });
                },
                function lookupServers(_, subcb) {
                        _self.log.debug('looking up servers');
                        var servers = [];
                        var vms = Object.keys(_self['VMAPI_VMS']);
                        for (var i = 0; i < vms.length; ++i) {
                                var vm = _self['VMAPI_VMS'][vms[i]];
                                var server = vm.server_uuid;
                                if (servers.indexOf(server) === -1) {
                                        servers.push(server);
                                }
                        }
                        vasync.forEachParallel({
                                'inputs': servers,
                                'func': findServer.bind(_self)
                        }, function (err, results) {
                                if (err) {
                                        subcb(err);
                                        return;
                                }
                                var opers = results.operations;
                                _self['CNAPI_SERVERS'] = {};
                                for (var j = 0; j < opers.length; ++j) {
                                        var uuid = servers[j];
                                        var res = opers[j].result;
                                        _self['CNAPI_SERVERS'][uuid] = res;
                                }
                                _self.log.debug({
                                        'servers': Object.keys(
                                                _self['CNAPI_SERVERS']).sort()
                                }, 'found cnapi servers');
                                subcb();
                        });
                },
                function gatherHosts(_, subcb) {
                        _self.log.debug('gathering host information');
                        var instances = Object.keys(_self['SAPI_INSTANCES']);
                        var agents = [];
                        _self['HOSTS'] = [];

                        //First the regular applications...
                        for (var i = 0; i < instances.length; ++i) {
                                var uuid = instances[i];
                                var vm = _self['VMAPI_VMS'][uuid];
                                var server_uuid = vm.server_uuid;
                                var sv = _self['CNAPI_SERVERS'][server_uuid];

                                //Save compute servers for agents...
                                // This also filters out compute instances
                                // from the list of things to monitor.
                                if (vm.tags &&
                                    vm.tags.manta_role === 'compute') {
                                        if (agents.indexOf(server_uuid) ===
                                            -1) {
                                                agents.push(server_uuid);
                                        }
                                        continue;
                                }
                                //Not something we're interested in...
                                if (!vm.tags ||
                                    !vm.tags.manta_role ||
                                    vm.tags.manta_role === 'madtom') {
                                        continue;
                                }

                                var hdc = sv.sysinfo['Datacenter Name'];
                                var nics = vm.nics;
                                var ip = null;
                                for (var j = 0; j < nics.length; ++j) {
                                        var nic = nics[j];
                                        var nt = _self['NETWORK_TAG'];
                                        if (nic.nic_tag === nt) {
                                                ip = nic.ip;
                                                break;
                                        }
                                }

                                if (!ip) {
                                        var m = 'vm doesnt have nics';
                                        _self.log.error({
                                                'uuid': uuid,
                                                'vm': vm
                                        }, m);
                                        return (subcb(new Error(m)));
                                }

                                //Finally build the host struct...
                                _self['HOSTS'].push({
                                        'hostType': vm.tags.manta_role,
                                        'ip': ip,
                                        'uuid': uuid,
                                        'datacenter': hdc,
                                        'server': server_uuid
                                });
                        }

                        //Now the marlin agents...
                        for (i = 0; i < agents.length; ++i) {
                                server_uuid = agents[i];
                                sv = _self['CNAPI_SERVERS'][server_uuid];
                                ip = findServerIp(_self['AGENT_NETWORK_TAG'],
                                                  sv);
                                hdc = sv.sysinfo['Datacenter Name'];
                                _self['HOSTS'].push({
                                        'hostType': 'agent',
                                        'ip': ip,
                                        'uuid': server_uuid,
                                        'datacenter': hdc,
                                        'server': server_uuid
                                });
                        }
                        subcb();
                }
        ]
}, function (err) {
        if (err) {
                _self.log.fatal(err);
                process.exit(1);
        }

        //Ok, now output hosts...
        var serialized = JSON.stringify({ hosts: _self['HOSTS']}, null, 2);
        fs.writeFileSync(_self['OUTPUT_FILENAME'], serialized);
        _self.log.debug('Done.');
        process.exit(0);
});
