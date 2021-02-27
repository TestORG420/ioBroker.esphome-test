'use strict';

/*
 * Created with @iobroker/create-adapter v1.31.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const { Client } = require('esphome-native-api');
const Mdns = require('mdns-js');
const stateAttr = require(__dirname + '/lib/stateAttr.js'); // Load attribute library
const disableSentry = true; // Ensure to set to true during development!
const warnMessages = {}; // Store warn messages to avoid multiple sending to sentry
const client = {};
let reconnectTimer, discoveryTimer, mdnsBrowser, reconnectInterval, apiPass, autodiscovery;

// Load your modules here, e.g.:
// const fs = require("fs");

class Esphome extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: 'esphome',
		});
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));

		this.deviceInfo  = {}; // Memory array of initiated objects
		this.deviceStateRelation  = {}; // Memory array of initiated device by Device Identifier (name) and IP
		this.createdStatesDetails = {}; // Array to store information of created states
		this.messageResponse = {}; // Array to store messages from admin and provide proper message to add/remove devices
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		await this.setStateAsync('info.connection', {val: true, ack: true});
		try {
			apiPass =  this.config.apiPass;
			autodiscovery =  this.config.autodiscovery;
			reconnectInterval = this.config.reconnectInterval * 1000;
			await this.tryKnownDevices(); // Try to establish connection to already known devices
			this.connectionMonitor(); // Start connection monitor
			if (autodiscovery){
				this.deviceDiscovery(); // Start MDNS autodiscovery
			}
		} catch (e) {
			this.log.error(`Connection issue ${e}`);
		}
	}

	// MDNS discovery handler for ESPHome devices
	deviceDiscovery(){
		mdnsBrowser = Mdns.createBrowser();
		mdnsBrowser.on('update', (data) => {
			this.log.debug('Discovery answer: ' + JSON.stringify(data));
			if (!data.addresses || !data.addresses[0] || !data.type) return;
			for (let i = 0; i < data.type.length; i++) {
				if (data.type[i].name === 'esphomelib') {
					this.log.info(`[AutoDiscovery] ESPHome device found at IP ${data.addresses}`);
					// Verify if device is already known
					if (this.deviceInfo[data.addresses] == null){
						this.log.info(`[AutoDiscovery] New ESPHome device found at IP ${data.addresses}`);
						// Store new Device information to device array in memory
						this.deviceInfo[data.addresses] = {
							ip: data.addresses,
							passWord: apiPass
						};
						this.connectDevices(`${data.addresses}`,`${apiPass}`);
					}
				}
			}
		});
		mdnsBrowser.on('ready', function () {
			mdnsBrowser.discover();
		});
	}

	// Try to contact to contact and read data of already known devices
	async tryKnownDevices() {

		const knownDevices = await this.getDevicesAsync();
		if (!knownDevices) {
			this.log.warn(`No device configured, please add device in adapter configuration`);
			return;
		} // exit function if no known device are detected

		// Get basic data of known devices and start reading data
		for (const i in knownDevices) {
			this.deviceInfo[knownDevices[i].native.ip] = {
				ip: knownDevices[i].native.ip,
				mac: knownDevices[i].native.mac,
				deviceName: knownDevices[i].native.deviceName,
				deviceInfoName: knownDevices[i].native.name,
				passWord: knownDevices[i].native.passWord,
			};
			this.connectDevices(knownDevices[i].native.ip, knownDevices[i].native.passWord);
		}
	}

	// Connection monitor/reconnect if connection to device is lost
	connectionMonitor(){
		try {
			reconnectTimer = setTimeout(() => {
				// Get basic data of known devices and start reading data
				for (const i in this.deviceInfo) {
					// Check if a connection instance exists, otherwise try to connect
					if (client[this.deviceInfo[i].ip]) {
						const connected = client[this.deviceInfo[i].ip].connected;
						this.log.debug(`${this.deviceInfo[i].ip} connection : ${connected}`);
						if (!connected){
							this.connectDevices(this.deviceInfo[i].ip, this.deviceInfo[i].passWord);
						}
					} else {
						this.connectDevices(this.deviceInfo[i].ip, this.deviceInfo[i].passWord);
					}
				}
				this.connectionMonitor();
			}, reconnectInterval);
		} catch (e) {
			console.error(e);
		}

	}

	// Handle Socket connections
	connectDevices(host, pass){

		try {
			// const host = espDevices[device].ip;
			this.log.info(`Initiate ${host}`);
			// Prepare connection attributes
			client[host] = new Client({
				host: host,
				password : this.decrypt(pass),
				clientInfo : `${this.host}`,
				clearSession: true,
				initializeDeviceInfo: true,
				initializeListEntities: true,
				initializeSubscribeStates: false,
				// initializeSubscribeLogs: false, //ToDo: Make configurable by adapter settings
				reconnect: false,
				reconnectInterval: 10000,
				pingInterval: 5000,
				pingAttempts: 3
				// port: espDevices[device].port //ToDo: Make configurable by adapter settings
			});

			// Connection listener
			client[host].on('connected', async () => {
				try {
					this.log.info(`ESPHome client ${host} connected`);
				} catch (e) {
					this.log.error(`connection error ${e}`);
				}
			});

			client[host].on('disconnected', () => {
				try {
					if (this.deviceInfo[host].deviceName != null) {
						this.setState(`${this.deviceInfo[host].deviceName}.info._online`, {val: false, ack: true});
						this.log.warn(`ESPHome  client  ${host} disconnected`);
					}
				} catch (e) {
					this.log.debug(`ESPHome disconnect error : ${e}`);
				}
			});

			client[host].on('initialized', () => {
				this.log.info(`ESPHome  client ${this.deviceInfo[host].deviceInfoName} on ip ${host} initialized`);
			});

			client[host].on('logs', (messageObj) => {
				this.log.debug(`ESPHome client log : ${JSON.stringify(messageObj)}`);
			});

			// Log message listener
			client[host].connection.on('message', (message) => {
				this.log.debug(`ESPHome ${host} client log ${message}`);
			});

			client[host].connection.on('data', (data) => {
				this.log.debug(`ESPHome ${host} client data ${data}`);
			});

			// Handle device information when connected or information updated
			client[host].on('deviceInfo', async (deviceInfo) => {
				try {
					this.log.info(`ESPHome Device info received for ${deviceInfo.name}`);

					// Store device information into memory
					const deviceName = this.replaceAll(deviceInfo.macAddress, `:`, ``);
					this.deviceInfo[host] = {
						ip: host,
						mac: deviceInfo.macAddress,
						deviceInfo: deviceInfo,
						deviceName: deviceName,
						deviceInfoName: deviceInfo.name,
						passWord: pass,
					};

					// Store MAC & IP relation
					this.deviceStateRelation[deviceName] = {'ip' : host};

					this.log.debug(`DeviceInfo : ${JSON.stringify(this.deviceInfo)}`);

					// Create Device main structure
					await this.extendObjectAsync(deviceName, {
						type: 'device',
						common: {
							name: deviceInfo.name,
						},
						native: {
							ip: host,
							name: this.deviceInfo[host].deviceInfoName,
							mac: deviceInfo.macAddress,
							deviceName: deviceName,
							passWord: pass,
						},
					});



					// Read JSON and handle states
					await this.TraverseJson(deviceInfo, `${deviceName}.info`);

					// Create connection indicator at device info channel
					await this.stateSetCreate(`${deviceName}.info._online`, `Online state`, true);

					// Check if device connection is caused by adding  device from admin, if yes send OK message
					if (this.messageResponse[host]) {
						const massageObj = {
							'type': 'info',
							'message': 'success'
						};
						// @ts-ignore
						this.respond(massageObj, this.messageResponse[host]);
						this.messageResponse[host] = null;
					}

				} catch (e) {
					this.log.error(`deviceInfo ${host} ${e}`);
				}
			});

			// Initialise data for states
			client[host].on('newEntity', async entity => {

				try {
					// Store relevant information into memory object
					this.deviceInfo[host][entity.id] = {
						config : entity.config,
						name : entity.name,
						type : entity.type,
						unit: entity.config.unitOfMeasurement !== undefined ? entity.config.unitOfMeasurement || '' : ''
					};

					this.log.info(`${this.deviceInfo[host][entity.id].type} found at ${this.deviceInfo[host].deviceInfoName} on ip ${this.deviceInfo[host].ip}`);

					// Create Device main structure
					await this.extendObjectAsync(`${this.deviceInfo[host].deviceName}.${entity.type}`, {
						type: 'channel',
						common: {
							name: entity.type,
						},
						native: {},
					});

					// Create state specific channel by id
					await this.extendObjectAsync(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}`, {
						type: 'channel',
						common: {
							name: entity.config.name
						},
						native: {},
					});

					// Create config channel
					await this.extendObjectAsync(`${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.config`, {
						type: 'channel',
						common: {
							name: 'Configuration data'
						},
						native: {},
					});

					// Handle Entity JSON structure and write related config channel data
					await this.TraverseJson(entity.config, `${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.config`);
					const stateName = this.deviceInfo[host][entity.id].config.objectId !== undefined ? this.deviceInfo[host][entity.id].config.objectId || 'state' : 'state';

					// Request current state values
					await client[host].connection.subscribeStatesService();
					this.log.debug(`[DeviceInfoData] ${JSON.stringify(this.deviceInfo[host])}`);

					// Listen to state changes an write values to states (create state if not yet exists)
					entity.on(`state`, async (state) => {
						try {
							// this.log.error(`${this.entities[state.key].type} value of ${this.entities[state.key].config.name} change to ${state.state}`);
							this.log.debug(`[entityStateConfig] ${JSON.stringify(this.deviceInfo[host][entity.id])}`);
							this.log.debug(`[entityStateData] ${JSON.stringify(state)}`);

							// Round value to digits as known by configuration
							let stateVal = state.state;

							if (this.deviceInfo[host][entity.id].config.accuracyDecimals != null) {
								const rounding = `round(${this.deviceInfo[host][entity.id].config.accuracyDecimals })`;
								this.log.debug(`Value "${stateVal}" for name "${entity}" before function modify with method "round(${this.deviceInfo[host][entity.id].config.accuracyDecimals})"`);
								stateVal = this.modify(rounding, stateVal);
								this.log.debug(`Value "${stateVal}" for name "${entity}" after function modify with method "${rounding}"`);
							}

							// Ensure proper initialisation of the state
							if (this.deviceInfo[host][entity.id].stateName == null) {
								let writable = false;
								if (this.deviceInfo[host][entity.id].type === `Switch`){
									writable = true;
								}
								this.deviceInfo[host][entity.id].stateName = `${this.deviceInfo[host].deviceName}.${entity.type}.${entity.id}.${stateName}`;
								await this.stateSetCreate( `${this.deviceInfo[host][entity.id].stateName}`, `value of ${entity.type}`, stateVal, this.deviceInfo[host][entity.id].unit, writable);
								// await this.setStateAsync(`${this.deviceInfo[host][entity.id].stateName}`, {val: stateVal, ack: true});
							}

							// State is already known, only update values
							await this.setStateAsync(`${this.deviceInfo[host][entity.id].stateName}`, {val: stateVal, ack: true});

						} catch (e) {
							this.log.error(`State handle error ${e}`);
						}

					});

					entity.connection.on(`destroyed`, async (state) => {
						try {
							this.log.warn(`Connection destroyed for ${state}`);
						} catch (e) {
							this.log.error(`State handle error ${e}`);
						}

					});

					entity.on(`error`, async (name) => {
						this.log.error(`Entity error: ${name}`);
					});


				} catch (e) {
					this.log.error(`Connection issue for ${entity.name} ${e}`);
				}

			});

			// Connection data handler
			client[host].on('error', (error) => {
				this.log.error(`ESPHome client ${host} ${error} `);
				// Check if device connection is caused by adding  device from admin, if yes send OK message
				if (this.messageResponse[host]) {

					const massageObj = {
						'type': 'error',
						'message': 'connection failed'
					};
					// @ts-ignore
					this.respond(massageObj, this.messageResponse[host]);
					this.messageResponse[host] = null;
				}
				try {
					client[host].disconnect();
				}  catch (e) {
					console.error(e);
				}
			});

			// connect to socket
			try {
				this.log.debug(`trying to connect to ${host}`);
				client[host].connect();
			} catch (e) {
				this.log.error(`Client ${host} connect error ${e}`);
			}

		}  catch (e) {
			this.log.error(`ESP device error for ${host}`);
		}

	}

	/**
	 * Traeverses the json-object and provides all information for creating/updating states
	 * @param {object} jObject Json-object to be added as states
	 * @param {string | null} parent Defines the parent object in the state tree; default=root
	 * @param {boolean} replaceName Steers if name from child should be used as name for structure element (channel); default=false
	 * @param {boolean} replaceID Steers if ID from child should be used as ID for structure element (channel); default=false;
	 * @param {number} state_expire expire time for the current setState in seconds; default is no expire
	 */
	async TraverseJson(jObject, parent = null, replaceName = false, replaceID = false, state_expire = 0) {
		let id = null;
		let value = null;
		let name = null;

		try {
			for (const i in jObject) {
				name = i;
				if (!!jObject[i] && typeof (jObject[i]) == 'object' && jObject[i] == '[object Object]') {
					if (parent == null) {
						id = i;
						if (replaceName) {
							if (jObject[i].name) name = jObject[i].name;
						}
						if (replaceID) {
							if (jObject[i].id) id = jObject[i].id;
						}
					} else {
						id = parent + '.' + i;
						if (replaceName) {
							if (jObject[i].name) name = jObject[i].name;
						}
						if (replaceID) {
							if (jObject[i].id) id = parent + '.' + jObject[i].id;
						}
					}
					// Avoid channel creation for empty arrays/objects
					if (Object.keys(jObject[i]).length !== 0) {
						console.log(`park`);
						await this.setObjectAsync(id, {
							'type': 'channel',
							'common': {
								'name': name,
							},
							'native': {},
						});
						await this.TraverseJson(jObject[i], id, replaceName, replaceID, state_expire);
					} else {
						this.log.debug('State ' + id + ' received with empty array, ignore channel creation');
					}
				} else {
					value = jObject[i];
					if (parent == null) {
						id = i;
					} else {
						id = parent + '.' + i;
					}
					if (typeof (jObject[i]) == 'object') value = JSON.stringify(value);
					//avoid state creation if empty
					if (value != '[]') {
						this.log.debug('create id ' + id + ' with value ' + value + ' and name ' + name);
						await this.stateSetCreate(id, name, value);
					}
				}
			}
		} catch (error) {
			this.log.error(`Error in function TraverseJson: ${error}`);
		}
	}

	/**
	 * Function to handle state creation
	 * proper object definitions
	 * rounding of values
	 * @param {string} objName ID of the object
	 * @param {string} name Name of state (also used for stattAttrlib!)
	 * @param {boolean | string | number | null} [value] Value of the state
	 * @param {string} [unit] Unit to be set
	 * @param {boolean} [writable] state writable ?
	 */
	async stateSetCreate(objName, name, value, unit, writable) {
		this.log.debug('Create_state called for : ' + objName + ' with value : ' + value);
		try {

			// Try to get details from state lib, if not use defaults. throw warning is states is not known in attribute list
			const common = {};
			// const entityID = objName.split('.');
			common.modify = {};
			if (!stateAttr[name]) {
				const warnMessage = `State attribute definition missing for '${name}'`;
				if (warnMessages[name] !== warnMessage) {
					warnMessages[name] = warnMessage;
					// Send information to Sentry
					// this.sendSentry(warnMessage);
				}
			}
			common.name = stateAttr[name] !== undefined ? stateAttr[name].name || name : name;
			common.type = typeof (value);
			common.role = stateAttr[name] !== undefined ? stateAttr[name].role || 'state' : 'state';
			common.read = true;
			common.unit = unit !== undefined ? unit || '' : '';
			// common.write = stateAttr[name] !== undefined ? stateAttr[name].write || false : false;
			common.write = writable !== undefined ? writable || false : false;
			common.modify = stateAttr[name] !== undefined ? stateAttr[name].modify || '' : '';
			this.log.debug(`MODIFY to ${name}: ${JSON.stringify(common.modify)}`);

			if ((!this.createdStatesDetails[objName])
				|| (this.createdStatesDetails[objName]
					&& (
						common.name !== this.createdStatesDetails[objName].name
						|| common.name !== this.createdStatesDetails[objName].name
						|| common.type !== this.createdStatesDetails[objName].type
						|| common.role !== this.createdStatesDetails[objName].role
						|| common.read !== this.createdStatesDetails[objName].read
						|| common.unit !== this.createdStatesDetails[objName].unit
						|| common.write !== this.createdStatesDetails[objName].write
					)
				)) {

				// console.log(`An attribute has changed : ${state}`);
				await this.extendObjectAsync(objName, {
					type: 'state',
					common
				});

			} else {
				// console.log(`Nothing changed do not update object`);
			}

			// Store current object definition to memory
			this.createdStatesDetails[objName] = common;

			// // Set value to state
			if (value != null) {
				// 	//this.log.info('Common.mofiy: ' + JSON.stringify(common.modify));
				// 	if (common.modify != '' && typeof common.modify == 'string') {
				// 		this.log.info(`Value "${value}" for name "${objName}" before function modify with method "${common.modify}"`);
				// 		value = modify(common.modify, value);
				// 		this.log.info(`Value "${value}" for name "${objName}" after function modify with method "${common.modify}"`);
				// 	} else if (typeof common.modify == 'object') {
				// 		for (let i of common.modify) {
				// 			this.log.info(`Value "${value}" for name "${objName}" before function modify with method "${i}"`);
				// 			value = modify(i, value);
				// 			this.log.info(`Value "${value}" for name "${objName}" after function modify with method "${i}"`);
				// 		}
				// 	}

				await this.setStateAsync(objName, {
					val: value,
					ack: true
				});
			}

			// // Timer to set online state to FALSE when not updated
			// if (name === 'online') {
			// 	// Clear running timer
			// 	if (stateExpire[objName]) {
			// 		clearTimeout(stateExpire[objName]);
			// 		stateExpire[objName] = null;
			// 	}
			//
			// 	// timer
			// 	stateExpire[objName] = setTimeout(async () => {
			// 		await this.setStateAsync(objName, {
			// 			val: false,
			// 			ack: true,
			// 		});
			// 		this.log.info('Online state expired for ' + objName);
			// 	}, this.executioninterval * 1000 + 5000);
			// 	this.log.debug('Expire time set for state : ' + name + ' with time in seconds : ' + (this.executioninterval + 5));
			// }

			// Subscribe on state changes if writable
			common.write && this.subscribeStates(objName);

		} catch (error) {
			this.log.error('Create state error = ' + error);
		}
	}

	/**
	 * Handles error mesages for log and Sentry
	 * @param {string} msg Error message
	 */
	sendSentry(msg) {
		try {
			if (!disableSentry) {
				this.log.info(`[Error catched and send to Sentry, thank you collaborating!] error: ${msg}`);
				if (this.supportsFeature && this.supportsFeature('PLUGINS')) {
					const sentryInstance = this.getPluginInstance('sentry');
					if (sentryInstance) {
						sentryInstance.getSentryObject().captureException(msg);
					}
				}
			} else {
				this.log.warn(`Sentry disabled, error catched : ${msg}`);
				console.error(`Sentry disabled, error catched : ${msg}`);
			}
		} catch (error) {
			this.log.error(`Error in function sendSentry: ${error}`);
		}
	}

	// Helper replace functions
	escapeRegExp(string) {
		return string.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
	}

	replaceAll(str, find, replace) {
		return str.replace(new RegExp(this.escapeRegExp(find), 'g'), replace);
	}

	/**
	 * Analysis modify element in stateAttr.js and executes command
	 * @param {string} method defines the method to be executed (e.g. round())
	 * @param {string | number | boolean} value value to be executed
	 */
	modify(method, value) {
		this.log.debug(`Function modify with method "${method}" and value "${value}"`);
		let result = null;
		try {
			if (method.match(/^custom:/gi) != null) {                               //check if starts with "custom:"
				value = eval(method.replace(/^custom:/gi, ''));                     //get value without "custom:"
			} else if (method.match(/^multiply\(/gi) != null) {                     //check if starts with "multiply("
				const inBracket = parseFloat(method.match(/(?<=\()(.*?)(?=\))/g));    //get value in brackets
				value = value * inBracket;
			} else if (method.match(/^divide\(/gi) != null) {                       //check if starts with "divide("
				const inBracket = parseFloat(method.match(/(?<=\()(.*?)(?=\))/g));    //get value in brackets
				value = value / inBracket;
			} else if (method.match(/^round\(/gi) != null) {                        //check if starts with "round("
				const inBracket = parseInt(method.match(/(?<=\()(.*?)(?=\))/g));      //get value in brackets
				value = Math.round(value * Math.pow(10, inBracket)) / Math.pow(10, inBracket);
			} else if (method.match(/^add\(/gi) != null) {                          //check if starts with "add("
				const inBracket = parseFloat(method.match(/(?<=\()(.*?)(?=\))/g));    //get value in brackets
				value = parseFloat(value) + inBracket;
			} else if (method.match(/^substract\(/gi) != null) {                    //check if starts with "substract("
				const inBracket = parseFloat(method.match(/(?<=\()(.*?)(?=\))/g));    //get value in brackets
				value = parseFloat(value) - inBracket;
			}
			else {
				const methodUC = method.toUpperCase();
				switch (methodUC) {
					case 'UPPERCASE':
						if (typeof value == 'string') result = value.toUpperCase();
						break;
					case 'LOWERCASE':
						if (typeof value == 'string') result = value.toLowerCase();
						break;
					case 'UCFIRST':
						if (typeof value == 'string') result = value.substring(0, 1).toUpperCase() + value.substring(1).toLowerCase();
						break;
					default:
						result = value;
				}
			}
			if (!result) return value;
			return result;
		} catch (error) {
			this.log.error(`Error in function modify for method ${method} and value ${value}.`);
			this.sendSentry(error);
			return value;
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			this.log.debug(JSON.stringify(this.deviceInfo));
			for (const device in this.deviceInfo) {
				try {
					client[device].disconnect();
				} catch (e) {
					this.log.debug(`[onUnload] ${JSON.stringify(e)}`);
				}
			}
			mdnsBrowser.stop();
			if (reconnectTimer){
				reconnectTimer = clearTimeout();
			}
			if (discoveryTimer){
				discoveryTimer = clearTimeout();
			}
			callback();
		} catch (e) {
			this.log.error(`[onUnload] ${JSON.stringify(e)}`);
			callback();
		}
	}

	/**
	 * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	 * Using this method requires "common.message" property to be set to true in io-package.json
	 * @param {ioBroker.Message} obj
	 */
	async onMessage(obj) {
		this.log.info('Data from configuration received : ' + JSON.stringify(obj));
		switch (obj.command) {
			case 'removeDevice':
				await this.deleteDeviceAsync(`${obj.message}`)
					.catch(async error => {
						if (error !== 'Not exists') {
							this.log.error(`deleteDeviceAsync has a problem: ${error.message}, stack: ${error.stack}`);
						}
						else {
							// do nothing
						}
					});

				break;

			case 'addDevice':

				// eslint-disable-next-line no-case-declarations,no-inner-declarations
				function validateIPaddress(ipaddress)
				{
					if (/^(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(ipaddress))
					{
						return (true);
					}
					return (false);
				}

				// eslint-disable-next-line no-case-declarations
				const ipValid = validateIPaddress(obj.message['device-ip']);
				if (!ipValid) {
					this.log.warn(`You entered an incorrect IP-Address, cannot add device !`);

					const massageObj = {
						'type': 'error',
						'message': 'connection failed'
					};
					// @ts-ignore
					this.respond(massageObj, obj);

				} else {
					this.log.info(`Valid IP address received`);
					this.messageResponse[obj.message['device-ip']] = obj;
					await this.connectDevices(obj.message['device-ip'],obj.message['device-pass']);
				}
				break;

		}

	}

	// responds to the adapter that sent the original message
	/**
	 * Send message back to admin instance
	 * @param {string} response
	 * @param {object} obj
	 */
	respond(response, obj) {
		if (obj.callback)
			this.sendTo(obj.from, obj.command, response, obj.callback);
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	async onStateChange(id, state) {
		try {
			if (state && state.ack === false) {
				// The state was changed
				// this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
				const device = id.split('.');
				const deviceIP = this.deviceStateRelation[device[2]].ip;
				await client[deviceIP].connection.switchCommandService({key: device[4], state: state.val});
			} else {
				// The state was deleted
			}
		} catch (e) {
			this.log.error(`[onStateChange] ${e}`);
		}
	}
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new Esphome(options);
} else {
	// otherwise start the instance directly
	new Esphome();
}