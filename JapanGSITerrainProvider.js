// JapanGSITerrainProvider: 地理院の　標高タイルデータをCesiumの地形モデルとして利用できるようにする
//
// 標高タイルに関する参照情報:
// https://maps.gsi.go.jp/development/ichiran.html
// https://maps.gsi.go.jp/development/hyokochi.html
//
// History:
// 2026年までのものはgit logで確認してください
// 2026/04/10 : 地理院の/dem/の公開データにz=0がなくなったたのを受けて、level0-8までは地球地図(demgm)を使用する。
//
// Note:
// テキストデータは廃止される可能性が高い(デフォルトをpngに)

(function () {
	var defaultValue = Cesium.defaultValue,
		defined = Cesium.defined,
		defineProperties = Cesium.defineProperties,
		loadText = Cesium.loadText,
		loadImage = Cesium.loadImage,
		fetchText = Cesium.Resource.fetchText,
		fetchImage = Cesium.Resource.fetchImage,
		throttleRequestByServer = Cesium.throttleRequestByServer,
		Event = Cesium.Event,
		Credit = Cesium.Credit,
		WebMercatorTilingScheme = Cesium.WebMercatorTilingScheme,
		HeightmapTerrainData = Cesium.HeightmapTerrainData,
		TerrainProvider = Cesium.TerrainProvider,
		TileAvailability = Cesium.TileAvailability,
		when = Cesium.when;
	/**/
	("use strict");

	var trailingSlashRegex = /\/$/;
	var defaultCredit = new Credit("国土地理院");
	var GSI_MAX_TERRAIN_LEVEL = 14;

	var JapanGSITerrainProvider = function JapanGSITerrainProvider(options) {
		var self = this;
		options = defaultValue(options, {});

		this._usePngData = defaultValue(options.usePngData, true);
		this._maxTerrainLevel = defaultValue(
			options.maxTerrainLevel,
			GSI_MAX_TERRAIN_LEVEL,
		);
		var url;
		if (this._usePngData) {
			url = defaultValue(
				options.url,
				"https://cyberjapandata.gsi.go.jp/xyz/dem",
			); // use https to disable google chrome's data saver for prevent bluring imagg.
			if (loadImage) {
				this._loadDataFunction = loadImage;
			} else {
				this._fetchDataFunction = fetchImage;
			}
		} else {
			url = defaultValue(options.url, "//cyberjapandata.gsi.go.jp/xyz/dem");
			if (loadText) {
				this._loadDataFunction = loadText;
			} else {
				this._fetchDataFunction = fetchText;
			}
		}

		/*
        if (!trailingSlashRegex.test(url)) {
            url = url + '/';
        }
*/

		this._url = url;
		this._proxy = options.proxy;
		this._heightPower = defaultValue(options.heightPower, 1);

		this._tilingScheme = new WebMercatorTilingScheme({
			numberOfLevelZeroTilesX: 2,
		});

		this._readyPromise = when.defer();
		this._readyPromise.resolve(true);

		// set availability
		this._availability = new TileAvailability(
			this._tilingScheme,
			this._maxTerrainLevel,
		);
		// 05/2018 Processing of this part is suspicious, but seems to work...
		this._availability.addAvailableTileRange(0, 0, 0, 0, 0);
		for (var i = 0; i < this._maxTerrainLevel; i++) {
			this._availability.addAvailableTileRange(
				i + 1,
				-65536,
				-65536,
				65536,
				65536,
			);
		}
		// It's pretty messy, Try overriding
		this._availability.computeMaximumLevelAtPosition = function (position) {
			console.log("called GSI's computeMaximumLevelAtPosition");
			return self._maxTerrainLevel;
		};

		this._heightmapWidth = 32;
		this._demDataWidth = 256;

		this._terrainDataStructure = {
			heightScale: 1,
			heightOffset: 0,
			elementsPerHeight: 1,
			stride: 1,
			elementMultiplier: 256,
		};

		this._levelZeroMaximumGeometricError =
			TerrainProvider.getEstimatedLevelZeroGeometricErrorForAHeightmap(
				this._tilingScheme.ellipsoid,
				this._heightmapWidth,
				this._tilingScheme.getNumberOfXTilesAtLevel(0),
			);

		this._errorEvent = new Event();

		var credit = defaultValue(options.credit, defaultCredit);
		if (typeof credit === "string") {
			credit = new Credit(credit);
		}
		this._credit = credit;
	};

	JapanGSITerrainProvider.prototype.requestTileGeometry = function (
		x,
		y,
		level,
		throttleRequests,
	) {
		var usePngData = this._usePngData;
		var orgx = x;
		var orgy = y;
		var shift = 0;
		if (level > this._maxTerrainLevel) {
			shift = level - this._maxTerrainLevel;
			level = this._maxTerrainLevel;
		}

		x >>= shift + 1;
		y >>= shift;
		var shiftx = (orgx % Math.pow(2, shift + 1)) / Math.pow(2, shift + 1);
		var shifty = (orgy % Math.pow(2, shift)) / Math.pow(2, shift);

		var url;

		var dsCat;
		if (level > 15) {
			// dem1a 航空レーザー1m
			dsCat = "1a";
		} else if (level == 15) {
			// dem5a 航空レーザー5m
			dsCat = "5a";
		} else if (level > 8) {
			// dem10 航空レーザー10m
			dsCat = "";
		} else {
			// 地球地図(全球)を使う
			dsCat = "gm";
		}

		if (usePngData) {
			url =
				this._url + dsCat + "_png" + "/" + level + "/" + x + "/" + y + ".png";
		} else {
			url = this._url + dsCat + "/" + level + "/" + x + "/" + y + ".txt";
		}

		var proxy = this._proxy;
		if (defined(proxy)) {
			url = proxy.getURL(url);
		}

		var promise;

		throttleRequests = defaultValue(throttleRequests, true);
		if (throttleRequestByServer) {
			// Patch for > CESIUM1.35
			if (throttleRequests) {
				promise = throttleRequestByServer(url, this._loadDataFunction);
				if (!defined(promise)) {
					return undefined;
				}
			} else {
				promise = this._loadDataFunction(url);
			}
		} else {
			if (this._loadDataFunction) {
				// ISSUE2: If a large number of points are requested with sampleTerrain or sampleTerrainMostDetailed, there seems to be a problem that no more queries are made with this throttle number as the upper limit.
				promise = this._loadDataFunction(
					url,
					null,
					new Cesium.Request({ throttle: true }),
				);
				//            	promise = this._loadDataFunction(url);
			} else {
				promise = this._fetchDataFunction({
					url: url,
					request: new Cesium.Request({ throttle: true }),
				});
			}
		}

		var self = this;
		return when(promise, function (data) {
			var heightCSV = [];
			var heights = [];
			if (usePngData) {
				var canvas = document.createElement("canvas");
				canvas.width = "256";
				canvas.height = "256";
				var cContext = canvas.getContext("2d");
				cContext.mozImageSmoothingEnabled = false;
				cContext.webkitImageSmoothingEnabled = false;
				cContext.msImageSmoothingEnabled = false;
				cContext.imageSmoothingEnabled = false;
				cContext.drawImage(data, 0, 0);
				var pixData = cContext.getImageData(0, 0, 256, 256).data;
				var alt;
				for (var y = 0; y < 256; y++) {
					heights = [];
					for (var x = 0; x < 256; x++) {
						var addr = (x + y * 256) * 4;
						var R = pixData[addr];
						var G = pixData[addr + 1];
						var B = pixData[addr + 2];
						var A = pixData[addr + 3];
						if (R == 128 && G == 0 && B == 0) {
							alt = 0;
						} else {
							//                          alt = (R << 16 + G << 8 + B);
							alt = R * 65536 + G * 256 + B;
							if (alt > 8388608) {
								alt = alt - 16777216;
							}
							alt = alt * 0.01;
						}
						heights.push(alt);
					}
					heightCSV.push(heights);
				}
			} else {
				var LF = String.fromCharCode(10);
				var lines = data.split(LF);
				for (var i = 0; i < lines.length; i++) {
					heights = lines[i].split(",");
					for (var j = 0; j < heights.length; j++) {
						if (heights[j] == "e") heights[j] = 0;
					}
					heightCSV[i] = heights;
				}
			}

			var whm = self._heightmapWidth;
			var wim = self._demDataWidth;
			var hmp = new Int16Array(whm * whm);

			for (var y = 0; y < whm; ++y) {
				for (var x = 0; x < whm; ++x) {
					var py = Math.round(
						(y / Math.pow(2, shift) / (whm - 1) + shifty) * (wim - 1),
					);
					var px = Math.round(
						(x / Math.pow(2, shift + 1) / (whm - 1) + shiftx) * (wim - 1),
					);

					hmp[y * whm + x] = Math.round(heightCSV[py][px] * self._heightPower);
				}
			}

			return new HeightmapTerrainData({
				buffer: hmp,
				width: self._heightmapWidth,
				height: self._heightmapWidth,
				structure: self._terrainDataStructure,
				// childTileMask: self._maxTerrainLevel, // 2026/04/10 これはコメントアウトして（デフォルト全子タイル存在）状態が正しそう
			});
		});
	};

	JapanGSITerrainProvider.prototype.getLevelMaximumGeometricError = function (
		level,
	) {
		return this._levelZeroMaximumGeometricError / (1 << level);
	};
	JapanGSITerrainProvider.prototype.hasWaterMask = function () {
		return !true;
	};
	JapanGSITerrainProvider.prototype.getTileDataAvailable = function (
		x,
		y,
		level,
	) {
		return true;
	};

	defineProperties(JapanGSITerrainProvider.prototype, {
		errorEvent: {
			get: function () {
				return this._errorEvent;
			},
		},

		credit: {
			get: function () {
				return this._credit;
			},
		},

		tilingScheme: {
			get: function () {
				return this._tilingScheme;
			},
		},

		readyPromise: {
			get: function () {
				return this._readyPromise.promise;
			},
		},

		availability: {
			get: function () {
				return this._availability;
			},
		},

		ready: {
			get: function () {
				return true;
			},
		},
	});

	Cesium.JapanGSITerrainProvider = JapanGSITerrainProvider;
})();
