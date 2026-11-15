
// can i has a cookie
const CookieCloud = {
	// Configuration
	api: localStorage.getItem('CookieCloudServer') || 'https://nullweb.org/api/cookie',
	token: localStorage.getItem('CookieCloudToken') || null,

	revision: null,
	exists: false,

	ready: false,
	startupChecked: false,
	loadingCloud: false,

	uploading: false,
	pendingSave: null,
	uploadTimer: null,

	initialized: false,
	menuInstalled: false,

	// User interface
	ui: {
		server: '',
		token: '',
		status: 'Not connected.',
		conflict: null
	},

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

	// Notifications
	notify(title, message, icon = [2, 3]) {
		if (typeof Game.Notify === 'function') {
			Game.Notify(title, message, icon);
		}

		console.log('[Cookie Cloud] ' + title + ': ' + message);
	},

	// Connection
	async connect(server, token) {
		server = server.trim().replace(/\/+$/, '');
		token = token.trim();

		if (!/^https?:\/\/[^/]+$/i.test(server)) {
			throw new Error('Invalid Cookie Cloud server URL.');
		}

		if (
			location.protocol === 'https:' &&
			server.startsWith('http://')
		) {
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

			this.ui.server = server;
			this.ui.token = token;
			this.ui.status = 'Connected to ' + server;

			console.log('[Cookie Cloud] Connected to:', server);

			this.notify(
				'Cookie Cloud',
			   'Successfully connected!'
			);

			this.startupSync();
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

		this.ui.server = '';
		this.ui.token = '';
		this.ui.status = 'Disconnected.';

		this.notify(
			'Cookie Cloud',
			'Disconnected successfully.'
		);
	},

	// Get cloud status
	async refreshStatus() {
		const status = await this.request('/status');

		this.exists = status.exists;
		this.revision = status.revision;

		return status;
	},

	// Get local save
	getLocalSave() {
		const save = Game.WriteSave(1);

		if (typeof save !== 'string' || !save.length) {
			throw new Error(
				'Cookie Clicker produced an invalid save.'
			);
		}

		return save;
	},

	// Upload save
	async uploadSnapshot(saveData, expectedRevision) {
		return await this.request('/save', {
			method: 'PUT',
			body: JSON.stringify({
				saveData,
				expectedRevision
			})
		});
	},

	// Load cloud save
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

		if (
			this.startupChecked ||
			!this.token ||
			!this.api
		) {
			return;
		}

		this.startupChecked = true;

		this.ui.status = 'Synchronizing...';

		try {
			const status = await this.refreshStatus();

			if (status.exists) {
				console.log('[Cookie Cloud] Cloud save found.');

				const cloud = await this.request('/save');

				await this.loadCloudSave(
					cloud.saveData,
					cloud.revision
				);

				this.notify(
					'Cookie Cloud',
				'Cloud save loaded successfully!'
				);
			} else {
				console.log('[Cookie Cloud] No cloud save found.');

				const localSave = this.getLocalSave();

				const result = await this.uploadSnapshot(
					localSave,
					0
				);

				this.revision = result.revision;
				this.exists = true;

				this.notify(
					'Cookie Cloud',
				'Cloud save created successfully!'
				);
			}

			this.ready = true;
			this.ui.status = 'Connected. Revision ' + this.revision;

		} catch (error) {
			console.error(
				'[Cookie Cloud] Startup synchronization failed:',
				 error
			);

			this.ready = false;
			this.ui.status = 'Synchronization failed: ' + error.message;

			this.notify(
				'Cookie Cloud',
			   'Synchronization failed. Check the console.',
			   [3, 5]
			);
		}
	},

	// Schedule upload
	scheduleUpload() {
		if (!this.ready || this.loadingCloud) return;

		this.pendingSave = this.getLocalSave();

		clearTimeout(this.uploadTimer);

		this.uploadTimer = setTimeout(() => {
			this.uploadTimer = null;
			this.processQueue();
		}, 2000);
	},

	// Upload queue
	async processQueue() {
		if (this.uploading || !this.ready) return;

		this.uploading = true;

		try {
			while (
				this.pendingSave !== null &&
				this.ready
			) {
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

					this.ui.status =
					'Connected. Revision ' + this.revision;

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

			this.ui.status = 'Upload failed: ' + error.message;

			this.notify(
				'Cookie Cloud',
			   'Upload failed: ' + error.message,
			   [3, 5]
			);

		} finally {
			this.uploading = false;

			if (
				this.pendingSave !== null &&
				this.ready
			) {
				this.processQueue();
			}
		}
	},

	// Revision conflicts
	async resolveConflict(localSave) {
		console.warn(
			'[Cookie Cloud] Revision conflict detected.'
		);

		const cloud = await this.request('/save');

		this.ui.conflict = {
			localSave,
			cloudSave: cloud.saveData,
			cloudRevision: cloud.revision
		};

		this.ui.status = 'Save conflict requires attention.';

		this.showConflictDialog();
	},

	// Conflict dialog
	showConflictDialog() {
		const conflict = this.ui.conflict;

		if (!conflict) return;

		const existing = document.getElementById(
			'cookieCloudConflict'
		);

		if (existing) existing.remove();

		const dialog = document.createElement('div');

		dialog.id = 'cookieCloudConflict';

		dialog.style.cssText = `
		position:fixed;
		inset:0;
		z-index:1000000;
		background:rgba(0,0,0,.8);
		display:flex;
		align-items:center;
		justify-content:center;
		`;

		dialog.innerHTML = `
		<div style="
		background:#222;
		color:white;
		padding:24px;
		border:2px solid #777;
		border-radius:8px;
		width:360px;
		max-width:90%;
		font-family:Arial,sans-serif;
		box-shadow:0 5px 30px #000;
		">
		<h2 style="margin-top:0">
		Cookie Cloud Conflict
		</h2>

		<p>
		Your cloud save is newer than your local save.
		</p>

		<p>
		Cloud revision:
		<strong>${conflict.cloudRevision}</strong>
		</p>

		<p>
		Choose which save to keep:
		</p>

		<button id="cookieCloudOverwrite" style="
		width:100%;
		padding:12px;
		margin:5px 0;
		cursor:pointer;
		">
		Overwrite Cloud
		</button>

		<button id="cookieCloudDownload" style="
		width:100%;
		padding:12px;
		margin:5px 0;
		cursor:pointer;
		">
		Load Cloud
		</button>
		</div>
		`;

		document.body.appendChild(dialog);

		document.getElementById(
			'cookieCloudOverwrite'
		).onclick = async () => {
			try {
				const result = await this.uploadSnapshot(
					conflict.localSave,
					conflict.cloudRevision
				);

				this.revision = result.revision;
				this.exists = true;

				this.ui.conflict = null;
				dialog.remove();

				this.ui.status =
				'Connected. Revision ' + this.revision;

				this.notify(
					'Cookie Cloud',
				'Cloud save overwritten successfully!'
				);

			} catch (error) {
				console.error(error);

				this.notify(
					'Cookie Cloud',
				'Could not overwrite cloud save: ' + error.message,
				[3, 5]
				);
			}
		};

		document.getElementById(
			'cookieCloudDownload'
		).onclick = async () => {
			try {
				this.pendingSave = null;

				await this.loadCloudSave(
					conflict.cloudSave,
					conflict.cloudRevision
				);

				this.ui.conflict = null;
				dialog.remove();

				this.ui.status =
				'Connected. Revision ' + this.revision;

				this.notify(
					'Cookie Cloud',
				'Cloud save loaded successfully!'
				);

			} catch (error) {
				console.error(error);

				this.notify(
					'Cookie Cloud',
				'Could not load cloud save: ' + error.message,
				[3, 5]
				);
			}
		};
	},

	// Install save hooks
	installHooks() {
		const originalWriteSave = Game.WriteSave;

		Game.WriteSave = function (type) {
			const result = originalWriteSave.apply(
				this,
				arguments
			);

			if (typeof type === 'undefined') {
				CookieCloud.scheduleUpload();
			}

			return result;
		};

		const originalLoadSave = Game.LoadSave;

		Game.LoadSave = function (
			data,
			ignoreVersionIssues
		) {
			const waitingForSteamSave =
			typeof data === 'undefined' &&
			typeof App !== 'undefined' &&
			App;

			const result = originalLoadSave.apply(
				this,
				arguments
			);

			if (
				!CookieCloud.loadingCloud &&
				!CookieCloud.startupChecked &&
				!waitingForSteamSave
			) {
				setTimeout(() => {
					CookieCloud.startupSync();
				}, 0);
			}

			return result;
		};
	},

	// Settings menu
	installMenu() {
		if (this.menuInstalled) return;

		this.menuInstalled = true;

		const originalUpdateMenu = Game.UpdateMenu;

		Game.UpdateMenu = function () {
			originalUpdateMenu.apply(this, arguments);

			if (Game.onMenu !== 'prefs') return;

			const anchor = document.getElementById('menu');

			if (!anchor) return;

			const section = document.createElement('div');

			section.className = 'subsection';
			section.id = 'cookieCloudSettings';

			section.innerHTML = `
			<div class="title">Cookie Cloud</div>

			<div class="listing">
			<div class="note">
			Sync your Cookie Clicker save
			with your own Cookie Cloud server.
			</div>
			</div>

			<div class="listing">
			<strong>Server URL</strong><br>
			<input
			id="cookieCloudServer"
			type="url"
			placeholder="https://nullweb.org"
			style="width:80%;"
			>
			</div>

			<div class="listing">
			<strong>API Token</strong><br>
			<input
			id="cookieCloudToken"
			type="password"
			placeholder="nwc_..."
			style="width:80%;"
			>
			</div>

			<div class="listing">
			<button class="smallFancyButton"
			id="cookieCloudConnect">
			Connect
			</button>

			<button class="smallFancyButton"
			id="cookieCloudDisconnect">
			Disconnect
			</button>
			</div>

			<div class="listing">
			<strong>Status:</strong>
			<span id="cookieCloudStatus"></span>
			</div>
			`;

			anchor.appendChild(section);

			const server = document.getElementById(
				'cookieCloudServer'
			);

			const token = document.getElementById(
				'cookieCloudToken'
			);

			const status = document.getElementById(
				'cookieCloudStatus'
			);

			server.value =
			CookieCloud.api
			? CookieCloud.api.replace(/\/api\/cookie$/, '')
			: '';

			token.value = CookieCloud.token || '';

			status.textContent = CookieCloud.ui.status;

			document.getElementById(
				'cookieCloudConnect'
			).onclick = async () => {
				try {
					status.textContent = 'Connecting...';

					await CookieCloud.connect(
						server.value,
						token.value
					);

					status.textContent =
					CookieCloud.ui.status;

				} catch (error) {
					console.error(
						'[Cookie Cloud] Connection failed:',
				   error
					);

					status.textContent =
					'Connection failed: ' + error.message;
				}
			};

			document.getElementById(
				'cookieCloudDisconnect'
			).onclick = () => {
				CookieCloud.disconnect();

				status.textContent =
				CookieCloud.ui.status;

				token.value = '';
			};
		};
	},

	// Mod initialization
	async init() {
		if (this.initialized) return;

		console.log('[Cookie Cloud] Initializing.');

		this.initialized = true;

		this.installHooks();
		this.installMenu();

		if (this.token && this.api) {
			this.ui.server = this.api.replace(
				/\/api\/cookie$/,
				''
			);

			this.ui.token = this.token;
			this.ui.status = 'Configured. Waiting for game...';

			if (Game.ready && !this.startupChecked) {
				setTimeout(() => {
					this.startupSync();
				}, 1500);
			}
		} else {
			this.ui.status = 'Not connected.';

			console.log(
				'[Cookie Cloud] No configuration found.'
			);
		}

		console.log('[Cookie Cloud] Initialized.');
	}
};

window.CookieCloud = CookieCloud;

// Register Steam mod
Game.registerMod('KingNullboy Cookie Cloud', {
	init: function () {
		CookieCloud.init();
	},

	save: function () {
		return '';
	},

	load: function (str) {}
});
