// can i has a cookie
const CookieCloud = {
	// Configuration
	api: localStorage.getItem('CookieCloudServer') || null,
	token: localStorage.getItem('CookieCloudToken') || null,

	revision: null,
	exists: false,

	ready: false,
	startupChecked: false,
	loadingCloud: false,

	uploading: false,
	pendingSave: null,
	uploadTimer: null,

	// API communication
	async request(endpoint, options = {}) {
		console.log('[Cookie Cloud] API request:', endpoint);

		if (!this.token || !this.api) {
			throw new Error('Cookie Cloud is not configured.');
		}

		const response = await fetch(this.api + endpoint, {
			...options,
			credentials: 'omit',
			headers: {
				'Authorization': 'Bearer ' + this.token,
				...(options.body ? {
					'Content-Type': 'application/json'
				} : {}),
				...options.headers
			}
		});

		let data;

		try {
			data = await response.json();
		} catch {
			throw new Error('Server returned an invalid response.');
		}

		if (!response.ok) {
			const error = new Error(
				data.error || 'API request failed.'
			);

			error.status = response.status;
			error.data = data;

			throw error;
		}

		return data;
	},

	// Token validation and setup
	async connect(server, token) {
		server = server.trim().replace(/\/+$/, '');
		token = token.trim();

		if (!/^https?:\/\/[^/]+$/i.test(server)) {
			throw new Error('Invalid Cookie Cloud server URL.');
		}

		if (location.protocol === 'https:' &&
			server.startsWith('http://')) {
			throw new Error(
				'HTTPS pages cannot connect to HTTP Cookie Cloud servers.'
			);
		}

		if (!/^nwc_[A-Za-z0-9_-]+$/.test(token)) {
			throw new Error('Invalid Cookie Cloud token format.');
		}

		const previousServer = this.api;
		const previousToken = this.token;

		const previousState = {
			revision: this.revision,
			exists: this.exists,
			ready: this.ready,
			startupChecked: this.startupChecked
		};

		// Stop pending uploads to the previous server.
		clearTimeout(this.uploadTimer);
		this.uploadTimer = null;
		this.pendingSave = null;

		this.ready = false;
		this.startupChecked = false;
		this.revision = null;
		this.exists = false;

		this.api = server + '/api/cookie';
		this.token = token;

		try {
			await this.refreshStatus();

			localStorage.setItem('CookieCloudServer', server);
			localStorage.setItem('CookieCloudToken', token);

			console.log('[Cookie Cloud] Connected to:', server);
		} catch (error) {
			this.api = previousServer;
			this.token = previousToken;

			Object.assign(this, previousState);

			throw error;
		}
	},

	// Disconnect
	disconnect() {
		clearTimeout(this.uploadTimer);

		this.uploadTimer = null;
		this.pendingSave = null;

		this.api = null;
		this.token = null;

		this.revision = null;
		this.exists = false;

		this.ready = false;
		this.startupChecked = false;

		localStorage.removeItem('CookieCloudServer');
		localStorage.removeItem('CookieCloudToken');

		console.log('[Cookie Cloud] Disconnected.');
	},

	// Get current cloud save information
	async refreshStatus() {
		const status = await this.request('/status');

		this.exists = status.exists;
		this.revision = status.revision;

		return status;
	},

	// Get the current local save
	getLocalSave() {
		const save = Game.WriteSave(1);

		if (typeof save !== 'string' || !save.length) {
			throw new Error('Cookie Clicker produced an invalid save.');
		}

		return save;
	},

	// Upload a particular save snapshot
	async uploadSnapshot(saveData, expectedRevision) {
		return await this.request('/save', {
			method: 'PUT',
			body: JSON.stringify({
				saveData,
				expectedRevision
			})
		});
	},

	// Download and apply the cloud save
	async loadCloudSave(saveData, revision) {
		this.loadingCloud = true;

		try {
			Game.LoadSave(saveData);
		} finally {
			this.loadingCloud = false;
		}

		this.revision = revision;
		this.exists = true;
	},

	// Initial synchronization
	async startupSync() {
		console.log('[Cookie Cloud] startupSync called');

		console.log('[Cookie Cloud] Flags:', {
			startupChecked: this.startupChecked,
			token: !!this.token,
			server: this.api
		});

		if (this.startupChecked || !this.token || !this.api) {
			console.log('[Cookie Cloud] Startup sync skipped.');
			return;
		}

		this.startupChecked = true;

		try {
			console.log('[Cookie Cloud] Requesting cloud status...');

			const status = await this.refreshStatus();

			console.log('[Cookie Cloud] Cloud status:', status);

			if (status.exists) {
				console.log('[Cookie Cloud] Cloud save found.');

				const cloud = await this.request('/save');

				await this.loadCloudSave(
					cloud.saveData,
					cloud.revision
				);

				console.log(
					'[Cookie Cloud] Loaded cloud revision',
					this.revision
				);

				Game.Notify(
					'Cookie Cloud',
					'Cloud save loaded successfully!',
					[2, 3]
				);
			} else {
				console.log(
					'[Cookie Cloud] No cloud save. Uploading local save.'
				);

				const localSave = this.getLocalSave();

				const result = await this.uploadSnapshot(
					localSave,
					0
				);

				this.revision = result.revision;
				this.exists = true;

				console.log(
					'[Cookie Cloud] Created cloud save, revision',
					this.revision
				);

				Game.Notify(
					'Cookie Cloud',
					'Cloud save created successfully!',
					[2, 3]
				);
			}

			this.ready = true;
		} catch (error) {
			console.error(
				'[Cookie Cloud] Startup synchronization failed:',
				error
			);

			Game.Notify(
				'Cookie Cloud',
				'Startup synchronization failed. Check the console.',
				[3, 5]
			);

			this.ready = false;
		}
	},

	// Schedule a debounced cloud upload
	scheduleUpload() {
		if (!this.ready || this.loadingCloud) return;

		this.pendingSave = this.getLocalSave();

		clearTimeout(this.uploadTimer);

		this.uploadTimer = setTimeout(() => {
			this.uploadTimer = null;
			this.processQueue();
		}, 2000);
	},

	// Process uploads sequentially
	async processQueue() {
		if (this.uploading || !this.ready) return;

		this.uploading = true;

		try {
			while (this.pendingSave !== null && this.ready) {
				const saveData = this.pendingSave;
				this.pendingSave = null;

				if (this.revision === null) {
					await this.refreshStatus();
				}

				try {
					const result = await this.uploadSnapshot(
						saveData,
						this.revision
					);

					this.revision = result.revision;
					this.exists = true;

					console.log(
						'[Cookie Cloud] Uploaded revision',
						this.revision
					);
				} catch (error) {
					if (error.status === 409) {
						await this.resolveConflict(saveData);
					} else {
						throw error;
					}
				}
			}
		} catch (error) {
			console.error('[Cookie Cloud] Upload failed:', error);

			alert(
				'Cookie Cloud upload failed:\n\n' +
				error.message
			);
		} finally {
			this.uploading = false;

			// Process a save that arrived while uploading.
			if (this.pendingSave !== null && this.ready) {
				this.processQueue();
			}
		}
	},

	// Resolve a revision conflict
	async resolveConflict(localSave) {
		console.warn('[Cookie Cloud] Revision conflict detected.');

		const cloud = await this.request('/save');

		const overwrite = confirm(
			'Your cloud save is newer than your local save.\n\n' +

			'Cloud revision: ' + cloud.revision + '\n\n' +

			'OK: Overwrite the cloud save with your local game.\n\n' +
			'Cancel: Load the newer cloud save.'
		);

		if (overwrite) {
			const result = await this.uploadSnapshot(
				localSave,
				cloud.revision
			);

			this.revision = result.revision;
			this.exists = true;

			console.log(
				'[Cookie Cloud] Overwrote cloud save. Revision:',
				this.revision
			);
		} else {
			// Discard queued local snapshots.
			this.pendingSave = null;

			await this.loadCloudSave(
				cloud.saveData,
				cloud.revision
			);

			console.log(
				'[Cookie Cloud] Loaded newer cloud revision',
				this.revision
			);
		}
	},

	// Install Cookie Clicker hooks
	installHooks() {
		// Hook normal saves (autosaves and manual saves).
		const originalWriteSave = Game.WriteSave;

		Game.WriteSave = function (type) {
			const result = originalWriteSave.apply(this, arguments);

			// type 1, 2, and 3 are export/debug formats.
			// The default call performs the actual local save.
			if (typeof type === 'undefined') {
				CookieCloud.scheduleUpload();
			}

			return result;
		};

		// Hook initial game loading.
		const originalLoadSave = Game.LoadSave;

		Game.LoadSave = function (data, ignoreVersionIssues) {
			// Steam may retrieve its save asynchronously through App.
			const waitingForSteamSave =
				typeof data === 'undefined' &&
				typeof App !== 'undefined' &&
				App;

			const result = originalLoadSave.apply(this, arguments);

			if (
				!CookieCloud.loadingCloud &&
				!CookieCloud.startupChecked &&
				!waitingForSteamSave
			) {
				// Let Cookie Clicker finish applying the local save first.
				setTimeout(() => {
					CookieCloud.startupSync();
				}, 0);
			}

			return result;
		};
	},

	// Mod initialization
	async init() {
		console.log('[Cookie Cloud] Initializing.');

		if (!this.token || !this.api) {
			const server = prompt(
				'Welcome to Cookie Cloud!\n\n' +
				'Enter your Cookie Cloud server URL:\n\n' +
				'Example: https://nullweb.org'
			);

			if (!server) {
				console.log('[Cookie Cloud] Setup skipped.');
				return;
			}

			const token = prompt(
				'Enter your Cookie Cloud API token:'
			);

			if (!token) {
				console.log('[Cookie Cloud] Setup skipped.');
				return;
			}

			try {
				await this.connect(server, token);
			} catch (error) {
				alert(
					'Cookie Cloud could not connect:\n\n' +
					error.message
				);

				return;
			}
		}

		this.installHooks();

		// Fallback in case the initial save was already loaded
		// before the mod finished initializing.
		if (Game.ready && !this.startupChecked) {
			setTimeout(() => {
				this.startupSync();
			}, 1500);
		}

		console.log('[Cookie Cloud] Initialized.');
	}
};

window.CookieCloud = CookieCloud;

// Register the Steam mod.
Game.registerMod('KingNullboy Cookie Cloud', {
	init: function () {
		CookieCloud.init();
	},

	save: function () {
		return '';
	},

	load: function (str) { }
});0