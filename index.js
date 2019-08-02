'use strict';

const async = require('async');
const AWS = require('aws-sdk');
const _ = require('lodash');
const request = require('request');

exports.errorLog = console.error;
exports.config = config;
exports.auth = auth;
exports.fetchInstances = fetchInstances;
exports.getInstances = getInstances;
exports.eachSeries = eachSeries;
exports.requestEachSeries = requestEachSeries;
exports.requestUntil = requestUntil;

function error_log(...args) {
  exports.errorLog("node-asg-tools",...args);
}

const g_aws_config = {};

const g_config = {
  MAX_INSTANCE_CACHE_AGE: 2*60*1000,
  use_ssl: false,
  port: false,
  use_public_ip: false,
};

function config(config,aws_config) {
  if (config) {
    _.extend(g_config,config);
  }
  if (aws_config) {
    _.extend(g_aws_config,aws_config);
  }

  if (!g_aws_config.region && !AWS.config.region) {
    get_aws_region(function(err, region) {
      if (!err && region) {
        g_aws_config.region = region;
      }
    });
  }
  return g_config;
}

function auth(req,res,next) {
  if (g_config.secret) {
    if (req.get('X-NODE-ASG-AUTH') === g_config.secret) {
      next();
    } else {
      res.header("Cache-Control", "no-cache, no-store, must-revalidate");
      res.sendStatus(403);
    }
  } else {
    next();
  }
}

function fetchInstances(done) {
  const instance_list = [];

  let auto_scale_group = false;
  async.series([
  (done) => {
    get_auto_scale_group((err,asg) => {
      if (!err) {
        auto_scale_group = asg;
      }
      done(err);
    });
  },
  (done) => {
    const ec2 = new AWS.EC2(g_aws_config);

    const all_id_list = _.pluck(auto_scale_group.Instances,'InstanceId');
    const id_list = all_id_list.filter(i => i !== g_instance_id);
    if (id_list.length == 0) {
      done(null);
    } else {
      const params = {
        InstanceIds: id_list,
      };
      ec2.describeInstances(params,(err,results) => {
        if (err) {
          error_log("describeInstances err:",err);
        } else {
          _.each(results.Reservations,(reservation) => {
            _.each(reservation.Instances,(instance) => {
              const state = instance.State.Name;
              if (state == 'running') {
                instance_list.push({
                  instance_id: instance.InstanceId,
                  private_ip: instance.PrivateIpAddress,
                  public_ip: instance.PublicIpAddress,
                });
              }
            });
          });
        }
        done(err);
      });
    }
  }],
  (err) => {
    done(err,instance_list);
  });
}

let g_instance_list = false;
let g_instance_list_fetch_date = 0;

function getInstances(done) {
  const age = Date.now() - g_instance_list_fetch_date;

  const is_old = age > g_config.MAX_INSTANCE_CACHE_AGE;

  if (is_old || !g_instance_list) {
    fetchInstances((err,list) => {
      if (!err) {
        g_instance_list = list;
        g_instance_list_fetch_date = Date.now();
      }
      done(err,g_instance_list);
    });
  } else {
    done(null,g_instance_list);
  }
}

function eachSeries(iterator,done) {
  getInstances((err,instance_list) => {
    if (!err) {
      async.eachSeries(instance_list,iterator,done);
    } else {
      done(err);
    }
  });
}

function requestEachSeries(options,done) {
  requestUntil(options,() => false,done);
}

function requestUntil(options,test,done) {
  const response_list = [];
  const body_list = [];

  eachSeries((instance,done) => {
    instance_request(options,instance,(err,response,body) => {
      if (err) {
        error_log("request err:",err);
      } else {
        response_list.push(response);
        body_list.push(body);
      }

      if (test(response,body)) {
        err = 'requestUntilDone';
      }
      done(err);
    });
  },
  (err) => {
    if (err == 'requestUntilDone') {
      err = false;
    }
    done(err,response_list,body_list);
  });
}

function instance_request(options,instance,done) {
  if (g_config.secret) {
    if (!options.headers) {
      options.headers = {};
    }
    if (!options.headers["X-NODE-ASG-AUTH"]) {
      options.headers["X-NODE-ASG-AUTH"] = g_config.secret;
    }
  }

  set_base_url(options,instance);
  try {
    request(options,done);
  } catch(e) {
    error_log("instance_request: request throw:",e);
    done(err);
  }
}

let g_instance_id = false;
function get_instance_id(done) {
  if (g_instance_id) {
    done(null,g_instance_id);
  } else {
    const meta = new AWS.MetadataService();
    meta.request('/latest/meta-data/instance-id',(err,results) => {
      if (err) {
        error_log("Failed to get instance id:",err);
      } else if (!results) {
        err = 'no_instance_id';
      } else {
        g_instance_id = results;
      }
      done(err,g_instance_id);
    });
  }
}

function get_auto_scale_group(done) {
  let instance_id = false;
  let found_asg = false;

  async.series([
  (done) => {
    if (g_config.asg_name) {
      done();
    } else {
      get_instance_id((err,id) => {
        instance_id = id;
        done(err);
      });
    }
  },
  (done) => {
    const opts = {};
    if (g_config.asg_name) {
      opts.AutoScalingGroupNames = [g_config.asg_name];
    }

    const autoscaling = new AWS.AutoScaling(g_aws_config);
    autoscaling.describeAutoScalingGroups(opts,(err,data) => {
      if (err) {
        error_log("get_auto_scale_group: err:",err);
      } else {
        if (instance_id) {
          _.every(data.AutoScalingGroups,(asg) => {
            const found_instance = _.findWhere(asg.Instances,{ InstanceId: instance_id });
            if (found_instance) {
              found_asg = asg;
            }
            return !found_asg;
          });
        } else {
          const asg = data.AutoScalingGroups[0];
          if (asg.AutoScalingGroupName === g_config.asg_name) {
            found_asg = asg;
          }
        }
      }
      done(err);
    });
  }],
  (err) => {
    if (!found_asg) {
      error_log("get_auto_scale_group: no ASG!");
      err = 'no_asg';
    }
    done(err,found_asg);
  });
}

function get_aws_region(done) {
  const m = new AWS.MetadataService();
  m.request('/latest/dynamic/instance-identity/document',(err,results) => {
    let region = false;
    if (!err) {
      try {
        const json_data = JSON.parse(results);
        region = json_data['region'];
      } catch(e) {
        err = e;
      }
    }
    done(err,region)
  });
}

function set_base_url(options,instance) {
  let base_url = "http://";
  if (g_config.use_https) {
    if (options.strictSSL === undefined) {
      options.strictSSL = false;
    }
    base_url = "https://";
  }

  if (g_config.use_public_ip) {
    base_url += instance.public_ip;
  } else {
    base_url += instance.private_ip;
  }

  if (g_config.port) {
    base_url += ":" + port;
  }
  options.baseUrl = base_url;
}
