(() => {
	'use strict';

	if (window.CookieCloud) {
		console.warn('[Cookie Cloud] Already loaded.');
		return;
	}

	const CookieCloud = {
		api: 'https://nullweb.org/api/cookie',
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

			if (!this.token) {
				throw new Error('No API token configured.');
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
		async connect(token) {
			token = token.trim();

			if (!/^nwc_[A-Za-z0-9_-]+$/.test(token)) {
				throw new Error('Invalid Cookie Cloud token format.');
			}

			const previousToken = this.token;
			this.token = token;

			try {
				await this.refreshStatus();
				localStorage.setItem('CookieCloudToken', token);
			} catch (error) {
				this.token = previousToken;
				throw error;
			}
		},

		// Get cloud save information
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
				throw new Error('Cookie Clicker produced an invalid save.');
			}

			return save;
		},

		// Upload save snapshot
		async uploadSnapshot(saveData, expectedRevision) {
			return await this.request('/save', {
				method: 'PUT',
				body: JSON.stringify({
					saveData,
					expectedRevision
				})
			});
		},

		// Apply cloud save
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

			if (this.startupChecked || !this.token) {
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
						null
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

		// Debounced uploads
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

				if (this.pendingSave !== null && this.ready) {
					this.processQueue();
				}
			}
		},

		// Resolve revision conflict
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
			const originalWriteSave = Game.WriteSave;

			Game.WriteSave = function (type) {
				const result = originalWriteSave.apply(this, arguments);

				if (typeof type === 'undefined') {
					CookieCloud.scheduleUpload();
				}

				return result;
			};

			const originalLoadSave = Game.LoadSave;

			Game.LoadSave = function (data, ignoreVersionIssues) {
				const result = originalLoadSave.apply(this, arguments);

				if (
					!CookieCloud.loadingCloud &&
					!CookieCloud.startupChecked
				) {
					setTimeout(() => {
						CookieCloud.startupSync();
					}, 0);
				}

				return result;
			};
		},

		// Initialization
		async init() {
			console.log('[Cookie Cloud] Initializing.');

			if (!this.token) {
				const token = prompt(
					'Welcome to Cookie Cloud!\n\n' +
					'Enter your NullWeb API token:'
				);

				if (!token) {
					console.log('[Cookie Cloud] Setup skipped.');
					return;
				}

				try {
					await this.connect(token);
				} catch (error) {
					alert(
						'Cookie Cloud could not connect:\n\n' +
						error.message
					);

					return;
				}
			}

			this.installHooks();

			// Fallback if the initial save already loaded.
			if (Game.ready && !this.startupChecked) {
				setTimeout(() => {
					this.startupSync();
				}, 1500);
			}

			console.log('[Cookie Cloud] Initialized.');
		}
	};

	window.CookieCloud = CookieCloud;

	// Wait for Cookie Clicker to initialize.
	function waitForGame() {
		if (
			typeof Game !== 'undefined' &&
			Game.WriteSave &&
			Game.LoadSave &&
			Game.Notify
		) {
			CookieCloud.init();
			return;
		}

		setTimeout(waitForGame, 250);
	}

	waitForGame();

})();