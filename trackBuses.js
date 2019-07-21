require('dotenv').config();
const request = require('request');
const router = require('express').Router();
const db = require('./db/index');
// const argv = require('yargs').option('dest', {type: 'array', desc: 'Bus destinations'}).option('route', {type: 'string', desc: 'Bus route'}).argv;

const BUSTIMEAPIURL = `https://bustime.mta.info/api/siri/vehicle-monitoring.json?key=${process.env.APIKEY}&LineRef=MTA+NYCT_B8`;
const TOMTOMAPIURL = `https://api.tomtom.com/traffic/services/4/flowSegmentData/relative/18/json?key=${process.env.TOMTOMKEY}&point=${mBustimeObj.VehicleLocation.Latitude},${mBustimeObj.VehicleLocation.Longitude}&unit=MPH`;

import Bus from './Bus';
import Bunch from './Bunch';
const layoverBuses = Bus.layoverBuses;
const movingBuses = Bus.movingBuses;
const busMap = Bus.busMap;
let intervId;
let isRunning;

runInterval();

function runInterval() {
    isRunning = true;
    intervId = setInterval(() => {
        const bustimeObjs = [];

        request({ url: BUSTIMEAPIURL }, function (error, response, body) {
            if (error) {
                console.log('error: ', error);
            }

            try {
                const json = JSON.parse(body);
                for (let i = 0; i < json.Siri.ServiceDelivery.VehicleMonitoringDelivery[0].VehicleActivity.length; i++) {
                    bustimeObjs.push(json.Siri.ServiceDelivery.VehicleMonitoringDelivery[0].VehicleActivity[i].MonitoredVehicleJourney);
                }
            } catch (err) {
                console.log(err)
            }

            checkForLayovers(bustimeObjs);
            checkIfMovingYet(bustimeObjs);
            trackBuses(bustimeObjs);
        });
    }, 5000);
}

function checkForLayovers(bustimeObjs) {
    //check if data on layover buses is still being returned by bustime. if not remove that bus from set.
    const everything = [];
    bustimeObjs.forEach(bustimeObj => {
        everything.push(bustimeObj.VehicleRef);
    });
    for (let bus of layoverBuses) {
        if (everything.indexOf(bus) === -1) {
            layoverBuses.delete(bus);
        }
    }
    //add buses to layover set
    bustimeObjs.forEach(bustimeObj => {
        if (bustimeObj.ProgressRate === 'noProgress' && bustimeObj.ProgressStatus === 'layover' && layoverBuses.has(bustimeObj.VehicleRef) !== true) {
            layoverBuses.add(bustimeObj.VehicleRef);
        }
        //if element approaching or 1 stop away from end stops
    });
}

function checkIfMovingYet(bustimeObjs) {
    if (layoverBuses.size > 0) {
        layoverBuses.forEach(bus => {
            bustimeObjs.forEach(bustimeObj => {
                if (bustimeObj.VehicleRef === bus && bustimeObj.ProgressRate === 'normalProgress') {
                    if (Array.from(movingBuses).some(movingBus => movingBus.vehicleref === bustimeObj.VehicleRef) !== true) {
                        movingBuses.add(new Bus(bus));
                        layoverBuses.delete(bus);
                    }
                    else {
                        layoverBuses.delete(bus);
                    }
                }

            });
        });
    }
}

function trackBuses(bustimeObjs) {
    movingBuses.forEach(bus => {
        if (bustimeObjs.some(bustimeObj => bustimeObj.VehicleRef === bus.vehicleref) !== true && bus.state !== 'disappeared' && bus.state !== 'no progress') {
            bus.wait('disappeared');
        }
    });

    movingBuses.forEach(movingBus => {
        bustimeObjs.forEach(bustimeObj => {
            if (bustimeObj.VehicleRef === movingBus.vehicleref && movingBus.state === null) {
                movingBus.state = 'new';
                movingBus.destination = bustimeObj.DestinationName;
                busMap.set(bustimeObj, movingBus);
            } else if (bustimeObj.VehicleRef === movingBus.vehicleref && movingBus.state === 'tracking') {
                busMap.set(bustimeObj, movingBus);
            } else if (bustimeObj.VehicleRef === movingBus.vehicleref && bustimeObj.DestinationName === movingBus.destination && movingBus.state === 'disappeared') {
                movingBus.returned();
                busMap.set(bustimeObj, movingBus);
            } else if (bustimeObj.VehicleRef === movingBus.vehicleref && bustimeObj.DestinationName === movingBus.destination && bustimeObj.ProgressRate === 'normalProgress' && movingBus.state === 'no progress') {
                movingBus.returned();
                busMap.set(bustimeObj, movingBus);
            }
        });
    });

    for (let [mBustimeObj, movingBus] of busMap) {
        movingBus.CallDistanceAlongRoute = mBustimeObj.MonitoredCall.Extensions.Distances.CallDistanceAlongRoute;
        try {
            if (movingBus.state === 'new') {
                const trip_id = `${mBustimeObj.VehicleRef}:${new Date().toLocaleString('en-US', { timeZone: 'America/New_York'} )}`;
                db.query(`INSERT INTO trips(trip_id, begin_time, vehicleref, destination, active) VALUES ($1, NOW(), $2, $3, $4)`, [trip_id, mBustimeObj.VehicleRef, mBustimeObj.DestinationName, true]).catch(e => console.log('233', e));
                movingBus.trip_id = trip_id;
                movingBus.state = 'tracking';
            }

            if (movingBus.state === 'tracking' && mBustimeObj.MonitoredCall) {
                if (mBustimeObj.MonitoredCall.Extensions.Distances.PresentableDistance === 'at stop' || mBustimeObj.MonitoredCall.Extensions.Distances.PresentableDistance === 'approaching') {
                    db.query(`INSERT INTO stops(trip_id, time, stop, stop_point_ref) SELECT $1, NOW(), $2, $3 WHERE NOT EXISTS (SELECT trip_id, stop FROM stops WHERE trip_id = $1 AND stop = $2)`, [movingBus.trip_id, mBustimeObj.MonitoredCall.StopPointName, mBustimeObj.MonitoredCall.StopPointRef]).catch(e => console.log('239', e));
                }
            }

            if (movingBus.state === 'tracking' && bustimeObjs.filter(obj => obj.DestinationName === mBustimeObj.DestinationName && obj.VehicleRef !== mBustimeObj.VehicleRef && obj.MonitoredCall).some(obj => Math.abs(mBustimeObj.MonitoredCall.Extensions.Distances.CallDistanceAlongRoute - obj.MonitoredCall.Extensions.Distances.CallDistanceAlongRoute) <= 609.6)) {//meters, 2000ft
                if (movingBus.bunched) {
                    db.query(`UPDATE trips SET bunch_time = coalesce(bunch_time, 0) + 5 WHERE trip_id = $1 RETURNING bunch_time`, [movingBus.trip_id])
                        .then(res => {
                            const bunch_time = Number.parseInt(res.rows[0].bunch_time);
                            if (bunch_time % 120 === 0 || bunch_time === 5) {
                                request({ url: TOMTOMAPIURL }, function (error, response, body) {
                                    try {
                                        body = JSON.parse(body);
                                        const speedRatio = body.flowSegmentData.currentSpeed / body.flowSegmentData.freeFlowSpeed;
                                        db.query(`INSERT INTO bunch_data(trip_id, time, traffic_speed, latitude, longitude) VALUES ($1, NOW(), $2, $3, $4)`, [movingBus.trip_id, speedRatio, mBustimeObj.VehicleLocation.Latitude, mBustimeObj.VehicleLocation.Longitude]).catch(e => console.log(e));
                                    }
                                    catch (err) {
                                        console.log(err, JSON.stringify(body, null, 2));
                                    }
                                });
                            }
                        }).catch(e => console.log('268', e));
                } else {
                    movingBus.bunched = true;
                }
            }

            if (movingBus.bunched) {
                if (bustimeObjs.some(obj => obj.DestinationName === mBustimeObj.DestinationName && obj.VehicleRef !== mBustimeObj.VehicleRef) !== true) {
                    movingBus.bunched = false;
                } else if (bustimeObjs.filter(obj => obj.DestinationName === mBustimeObj.DestinationName && obj.VehicleRef !== mBustimeObj.VehicleRef).some(obj => Math.abs(mBustimeObj.MonitoredCall.Extensions.Distances.CallDistanceAlongRoute - obj.MonitoredCall.Extensions.Distances.CallDistanceAlongRoute) <= 609.6) !== true) {
                    movingBus.bunched = false;
                }
            }

            if (mBustimeObj.ProgressRate && mBustimeObj.ProgressRate === 'noProgress')
                movingBus.wait('no progress');

            if (movingBus.DestinationName === 'BAY RIDGE 95 ST STA' && mBustimeObj.MonitoredCall.StopPointName === '4 AV/95 ST') {
                if (mBustimeObj.MonitoredCall.Extensions.Distances.PresentableDistance === 'approaching' || mBustimeObj.MonitoredCall.Extensions.Distances.PresentableDistance === 'at stop') {
                    movingBus.endNow('reached terminal');
                }
            }

            if (movingBus.DestinationName === 'BROWNSVILLE ROCKAWAY AV' && mBustimeObj.DestinationName.StopPointName === 'ROCKAWAY AV/HEGEMAN AV') {
                if (mBustimeObj.MonitoredCall.Extensions.Distances.PresentableDistance === 'approaching' || mBustimeObj.MonitoredCall.Extensions.Distances.PresentableDistance === 'at stop') {
                    movingBus.endNow('reached terminal');
                }
            }

            if (movingBus.DestinationName === 'V A HOSP' && mBustimeObj.DestinationName.StopPointName === 'VA HOSPITAL/MAIN ENT BAY 2') {
                if (mBustimeObj.MonitoredCall.Extensions.Distances.PresentableDistance === 'approaching' || mBustimeObj.MonitoredCall.Extensions.Distances.PresentableDistance === 'at stop') {
                    movingBus.endNow('reached terminal');
                }
            }
        } catch (err) {
            console.log(err, JSON.stringify(mBustimeObj, null, 2));
        }
    }

    busMap.clear();
}

router.get('/toggle/:state', function (req, res) {
    if (req.params.state === 'on' && isRunning === false) {
        runInterval();
        res.status(200);
        res.end();
    } else if (req.params.state === 'on' && isRunning === true) {
        res.send('Interval is already running');
        res.end();
    } else if (req.params.state === 'off' && isRunning === true) {
        clearInterval(intervId);
        isRunning = false;
        res.status(200);
        res.end();
    } else if (req.params.state === 'off' && isRunning === false) {
        res.send('Interval is already off');
        res.end();
    } else if (req.params.state === 'status') {
        res.send(isRunning);
        res.end();
    }
});

router.get('/movingbuses', function (req, res) {
    const buses = Array.from(movingBuses).map(bus => {
        const { vehicleref, destination, state, trip_id, bunched } = bus;
        const mappedBus = {};
        mappedBus.vehicleref = vehicleref;
        mappedBus.destination = destination;
        mappedBus.state = state;
        mappedBus.trip_id = trip_id;
        mappedBus.bunched = bunched;
        return JSON.stringify(mappedBus, null, 2);
    });
    res.send({ movingBuses: buses });
    res.end();
});

router.get('/layoverbuses', function (req, res) {
    res.send({ layoverBuses: Array.from(layoverBuses) });
    res.end();
});

module.exports = router;
