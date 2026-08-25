// Coarse Grid Generator with 3D Visualization
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class CoarseGenerator {
    constructor() {
        this.profilesData = null;
        this.generatedCoarse = null;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.gridMesh = null;
    }

    // Parse Profiles.dat file
    parseProfilesData(fileContent) {
        const lines = fileContent.split('\n');
        const periods = new Set();
        const stationsMap = new Map(); // Map: station code -> {x, y, z}

        for (const line of lines) {
            if (line.trim().startsWith('#') || line.trim().startsWith('>') || !line.trim()) continue;

            const parts = line.trim().split(/\s+/);
            if (parts.length >= 7) {
                const period = parseFloat(parts[0]);
                const code = parts[1];
                const x = parseFloat(parts[4]); // X coordinate (column 5)
                const y = parseFloat(parts[5]); // Y coordinate (column 6)
                const z = parseFloat(parts[6]); // Z coordinate (column 7)

                if (!isNaN(period) && !isNaN(x) && !isNaN(y)) {
                    periods.add(period);
                    // Store unique station coordinates (avoid duplicates from multiple periods/components)
                    if (!stationsMap.has(code)) {
                        stationsMap.set(code, { x, y, z });
                    }
                }
            }
        }

        // Extract unique coordinates
        const xCoords = Array.from(stationsMap.values()).map(s => s.x);
        const yCoords = Array.from(stationsMap.values()).map(s => s.y);

        return {
            numStations: stationsMap.size,
            numPeriods: periods.size,
            xMin: Math.min(...xCoords),
            xMax: Math.max(...xCoords),
            yMin: Math.min(...yCoords),
            yMax: Math.max(...yCoords),
            xRange: Math.max(...xCoords) - Math.min(...xCoords),
            yRange: Math.max(...yCoords) - Math.min(...yCoords),
            stations: Array.from(stationsMap.keys()),
            periods: Array.from(periods).sort((a, b) => a - b)
        };
    }

    // Generate X/Y cells with proper geometric progression (ModEM/MT3D style)
    // The list is built as one half (centre -> boundary) and then mirrored, so it is
    // exactly symmetric: uniform "core" cells cover the station area, geometric
    // padding grows towards the model boundary. Symmetry is what keeps the core zone
    // centred on the station area once the origin is placed at centre - extent / 2.
    // `minCellSize` is the target core cell size; it is only reached if the cell
    // budget allows it (at most half of the cells per side go into the core).
    generateXYCells(min, max, nCells, padding = 1.3, growthFactor = 1.2, minCellSize = 30000) {
        const stationRange = Math.max(max - min, minCellSize);

        // Fine (core) zone: station area plus a margin on each side
        const coreExtent = stationRange * Math.max(padding, 1.0);

        if (nCells <= 2) {
            return new Array(nCells).fill(coreExtent / nCells);
        }

        // Cells per side; for an odd nCells one extra core cell sits exactly in the middle
        const nHalf = Math.floor(nCells / 2);
        const nCentre = nCells % 2;

        // Core cells per side - never more than half of them, so padding always exists
        const nCoreHalf = Math.min(
            Math.max(1, Math.ceil(coreExtent / 2 / minCellSize)),
            Math.max(1, Math.floor(nHalf * 0.5))
        );
        const nPaddingHalf = nHalf - nCoreHalf;
        const coreSize = coreExtent / (2 * nCoreHalf + nCentre);

        // One half of the grid, from the centre towards the boundary
        const half = [];
        for (let i = 0; i < nCoreHalf; i++) {
            half.push(coreSize);
        }
        let size = coreSize;
        for (let i = 0; i < nPaddingHalf; i++) {
            size *= growthFactor;
            half.push(size);
        }

        // Mirror: boundary -> centre | [centre cell] | centre -> boundary
        const cells = [...half].reverse();
        if (nCentre) cells.push(coreSize);
        cells.push(...half);

        const total = cells.reduce((a, b) => a + b, 0);
        console.log(`[GRID GEN] stations: ${(stationRange / 1000).toFixed(1)} km, ` +
            `cells: ${cells.length}/${nCells}, ` +
            `core: ${2 * nCoreHalf + nCentre} x ${coreSize.toFixed(0)} m = ${(coreExtent / 1000).toFixed(1)} km, ` +
            `padding: ${nPaddingHalf} per side, total: ${(total / 1000).toFixed(1)} km`);

        return cells;
    }

    // Generate Z cells based on skin depth at highest frequency
    // For MT: skin depth δ = 503 * sqrt(ρ / f) meters
    // Требуется 3-5 ячеек на скин-слой
    generateZCells(nZ, firstLayer = 500, growthFactor = 1.15, maxPeriod = 10000) {
        const cells = [];

        // First layers (near surface) - for high frequency skin depth
        // Assuming ρ ≈ 100 Ω·m, f_max = 1/T_min
        // At T=10s, δ ≈ 503 * sqrt(100/0.1) ≈ 15900m
        // First cell should be ~500m for good resolution at high frequencies

        let currentSize = firstLayer;

        // First few layers with slower growth (skin layer resolution)
        const nSkinLayers = Math.min(Math.floor(nZ * 0.2), 10);
        const skinGrowth = 1.05; // Slower growth in skin layer

        for (let i = 0; i < nSkinLayers; i++) {
            cells.push(currentSize);
            currentSize *= skinGrowth;
        }

        // Deeper layers with faster geometric progression
        for (let i = nSkinLayers; i < nZ; i++) {
            cells.push(currentSize);
            currentSize *= growthFactor;
        }

        return cells;
    }

    // Build Coarse.dat content
    buildCoarseContent(config, xCells, yCells, zCells) {
        const timestamp = new Date().toISOString().split('T')[0];
        let content = `Coarse model written by User ${timestamp}\n`;
        content += `${config.nX} ${config.nY} ${config.nZ} 0   LINEAR\n`;

        // X cells - ALL values in ONE line
        content += xCells.map(v => v.toFixed(2)).join(' ') + '\n';

        // Y cells - ALL values in ONE line
        content += yCells.map(v => v.toFixed(2)).join(' ') + '\n';

        // Z cells - ALL values in ONE line
        content += zCells.map(v => v.toFixed(2)).join(' ') + '\n';

        // Resistivity values with CORRECT format: +X.XXXXXE+XX (two digits in exponent)
        // For each Z layer: nY rows of nX values, then empty line
        for (let z = 0; z < config.nZ; z++) {
            for (let y = 0; y < config.nY; y++) {
                const row = [];
                for (let x = 0; x < config.nX; x++) {
                    // Format: +1.00000E+02 (with leading +, 5 decimals, E+XX with TWO digits)
                    const expStr = config.defaultRho.toExponential(5);
                    // Parse exponent to ensure two digits
                    const match = expStr.match(/^([+-]?\d\.\d{5})e([+-])(\d+)$/i);
                    if (match) {
                        const mantissa = match[1];
                        const sign = match[2];
                        const exp = match[3].padStart(2, '0'); // Ensure two digits: 2 -> 02
                        const formatted = `${mantissa}E${sign}${exp}`;
                        // Ensure leading + for positive numbers
                        const withPlus = formatted.startsWith('-') ? formatted : '+' + formatted;
                        row.push(withPlus.toUpperCase());
                    } else {
                        // Fallback
                        row.push('+1.00000E+02');
                    }
                }
                content += row.join(' ') + '\n';
            }
            // Empty line after each Z layer (except the last one)
            if (z < config.nZ - 1) {
                content += '\n';
            }
        }

        // CRITICAL: Add origin coordinates at the end
        // Origin = bottom-left corner of the grid
        // Calculate from profilesStats if available, otherwise use (0, 0, 0)
        const originX = config.originX || 0;
        const originY = config.originY || 0;
        const originZ = config.originZ || 0;
        content += `${originX.toFixed(2)} ${originY.toFixed(2)} ${originZ.toFixed(2)}\n`;

        return content;
    }

    // Generate complete Coarse.dat
    generateCoarse(profilesStats, config) {
        const xCells = this.generateXYCells(
            profilesStats.xMin,
            profilesStats.xMax,
            config.nX,
            config.padding,
            config.growthFactor,
            config.minCellSize
        );

        const yCells = this.generateXYCells(
            profilesStats.yMin,
            profilesStats.yMax,
            config.nY,
            config.padding,
            config.growthFactor,
            config.minCellSize
        );

        const zCells = this.generateZCells(
            config.nZ,
            config.zFirstLayer,
            config.zGrowthFactor
        );

        // Calculate origin (bottom-left corner of grid)
        // Grid extends beyond station area due to padding
        const xExtent = xCells.reduce((a, b) => a + b, 0);
        const yExtent = yCells.reduce((a, b) => a + b, 0);

        // Center of station area
        const centerX = (profilesStats.xMin + profilesStats.xMax) / 2;
        const centerY = (profilesStats.yMin + profilesStats.yMax) / 2;

        // Origin is at bottom-left corner (grid is centered around station area).
        // Because xCells/yCells are mirror-symmetric, this puts the fine core zone
        // exactly around the station area.
        config.centerX = centerX;
        config.centerY = centerY;
        config.originX = centerX - (xExtent / 2);
        config.originY = centerY - (yExtent / 2);
        config.originZ = 0.0;

        console.log(`[COARSE GENERATOR] Grid origin: X=${config.originX.toFixed(2)}, Y=${config.originY.toFixed(2)}, Z=${config.originZ.toFixed(2)}`);
        console.log(`[COARSE GENERATOR] Station center: X=${centerX.toFixed(2)}, Y=${centerY.toFixed(2)}`);
        console.log(`[COARSE GENERATOR] Grid extent: X=${xExtent.toFixed(2)}, Y=${yExtent.toFixed(2)}`);

        const content = this.buildCoarseContent(config, xCells, yCells, zCells);

        // Actual core/padding split, read back from the generated cell lists
        const nCore = cells => {
            const smallest = Math.min(...cells);
            return cells.filter(v => Math.abs(v - smallest) < 1e-6).length;
        };
        const layout = {
            nCoreX: nCore(xCells),
            nPaddingX: config.nX - nCore(xCells),
            nCoreY: nCore(yCells),
            nPaddingY: config.nY - nCore(yCells)
        };

        this.generatedCoarse = {
            content,
            xCells,
            yCells,
            zCells,
            layout,
            config,
            stats: profilesStats
        };

        return this.generatedCoarse;
    }

    // Initialize 3D visualization
    init3DVisualization(containerElement, gridData, profilesStats = null) {
        const width = containerElement.clientWidth;
        const height = containerElement.clientHeight;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a0f);

        // Camera - adjusted for better view
        const { xCells, yCells, zCells } = gridData;
        const xExtent = xCells.reduce((a, b) => a + b, 0);
        const yExtent = yCells.reduce((a, b) => a + b, 0);
        const zExtent = zCells.reduce((a, b) => a + b, 0);
        const maxExtent = Math.max(xExtent, yExtent, zExtent);

        this.camera = new THREE.PerspectiveCamera(50, width / height, maxExtent * 0.01, maxExtent * 10);

        // IMPORTANT: Set camera up vector to make Z axis point up (Cartesian coordinates)
        // before lookAt(), so the initial orientation is already computed with Z up
        this.camera.up.set(0, 0, 1);

        const cameraDistance = maxExtent * 1.5;
        // Position camera to see the grid from an angle
        this.camera.position.set(cameraDistance * 0.8, cameraDistance * 0.8, cameraDistance * 1.0);
        this.camera.lookAt(0, 0, -zExtent * 0.3);

        // Renderer with better settings
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true
        });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        containerElement.innerHTML = '';
        containerElement.appendChild(this.renderer.domElement);

        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.maxDistance = maxExtent * 5;
        this.controls.minDistance = maxExtent * 0.1;
        this.controls.target.set(0, 0, -zExtent * 0.3);

        // Lights - improved for better visibility
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight1.position.set(1, 1, 0.5);
        this.scene.add(directionalLight1);

        const directionalLight2 = new THREE.DirectionalLight(0x4a90e2, 0.5);
        directionalLight2.position.set(-1, -0.5, -0.5);
        this.scene.add(directionalLight2);

        const directionalLight3 = new THREE.DirectionalLight(0xff6b6b, 0.3);
        directionalLight3.position.set(0, -1, 0.5);
        this.scene.add(directionalLight3);

        // Add grid
        this.addGridToScene(gridData);

        // Add observation stations if provided
        if (profilesStats) {
            this.addObservationStations(profilesStats, gridData);
        }

        // Add coordinate axes with labels
        this.addCoordinateAxes(maxExtent, xExtent, yExtent, zExtent);

        // NO grid helper - stations use absolute coordinates

        // Animation loop
        const animate = () => {
            requestAnimationFrame(animate);
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        animate();

        // Handle resize
        const handleResize = () => {
            const newWidth = containerElement.clientWidth;
            const newHeight = containerElement.clientHeight;
            this.camera.aspect = newWidth / newHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(newWidth, newHeight);
        };
        window.addEventListener('resize', handleResize);

        // Store resize handler for cleanup
        this.resizeHandler = handleResize;
    }

    // Add observation stations as cones on the surface
    addObservationStations(profilesStats, gridData) {
        if (!this.profilesData) return;

        const { xCells, yCells } = gridData;
        const xExtent = xCells.reduce((a, b) => a + b, 0);
        const yExtent = yCells.reduce((a, b) => a + b, 0);
        const maxExtent = Math.max(xExtent, yExtent);

        // Parse stations from profiles data - get unique station coordinates
        const lines = this.profilesData.split('\n');
        const stationsMap = new Map();

        for (const line of lines) {
            if (line.trim().startsWith('#') || line.trim().startsWith('>') || !line.trim()) continue;

            const parts = line.trim().split(/\s+/);
            if (parts.length >= 7) {
                const code = parts[1];
                const x = parseFloat(parts[4]);
                const y = parseFloat(parts[5]);
                const z = parseFloat(parts[6]);

                if (!isNaN(x) && !isNaN(y)) {
                    stationsMap.set(code, { x, y, z });
                }
            }
        }

        // Create cone geometry for stations
        const coneHeight = maxExtent * 0.03;
        const coneRadius = maxExtent * 0.015;
        const coneGeometry = new THREE.ConeGeometry(coneRadius, coneHeight, 8);

        // Material for station cones - bright orange/yellow
        const coneMaterial = new THREE.MeshPhongMaterial({
            color: 0xFFAA00,
            emissive: 0xFF6600,
            emissiveIntensity: 0.3,
            shininess: 30,
            transparent: false
        });

        // Group for all stations
        const stationsGroup = new THREE.Group();

        // The grid is drawn centred on the station area (see addGridToScene), so the
        // stations are drawn relative to that same centre, using the same axis mapping:
        // scene X = East (model Y), scene Y = North (model X).
        const centerX = (profilesStats.xMin + profilesStats.xMax) / 2; // North
        const centerY = (profilesStats.yMin + profilesStats.yMax) / 2; // East

        console.log(`[COARSE GENERATOR] Station centre (model coords): X(N)=${centerX.toFixed(2)}, Y(E)=${centerY.toFixed(2)}`);

        stationsMap.forEach(({ x, y, z }, code) => {
            // model X = North -> scene Y, model Y = East -> scene X
            const sceneX = y - centerY;
            const sceneY = x - centerX;

            console.log(`[COARSE GENERATOR] Station ${code}: X(N)=${x.toFixed(2)}, Y(E)=${y.toFixed(2)}, Z=${z.toFixed(2)}`);

            // Create cone for this station
            const cone = new THREE.Mesh(coneGeometry, coneMaterial);

            // Position cone at station location on the surface (Z = 0)
            cone.position.set(sceneX, sceneY, coneHeight / 2);

            // Cone in Three.js points along +Y by default; rotate +90 deg around X
            // so the apex points up along +Z (out of the ground)
            cone.rotation.x = Math.PI / 2;

            stationsGroup.add(cone);
        });

        this.scene.add(stationsGroup);

        console.log(`[COARSE GENERATOR] Added ${stationsMap.size} observation stations (East -> scene X, North -> scene Y)`);
    }

    // Add coordinate axes with labels
    // Scene X = model Y (East, green), scene Y = model X (North, red), scene -Z = depth
    addCoordinateAxes(maxExtent, xExtent, yExtent, zExtent) {
        // Axes parameters - increased length for better visibility
        const axisLength = maxExtent * 0.7;
        const arrowSize = axisLength * 0.04;
        const labelDistance = axisLength * 1.12;

        // Create axes geometry
        const axesGroup = new THREE.Group();

        // Scene X axis = model Y / East (Green)
        const xAxisGeometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(axisLength, 0, 0)
        ]);
        const xAxisMaterial = new THREE.LineBasicMaterial({ color: 0x00ff00, linewidth: 3 });
        const xAxis = new THREE.Line(xAxisGeometry, xAxisMaterial);
        axesGroup.add(xAxis);

        // East arrow
        const xArrowGeometry = new THREE.ConeGeometry(arrowSize * 0.5, arrowSize * 2, 8);
        const xArrowMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
        const xArrow = new THREE.Mesh(xArrowGeometry, xArrowMaterial);
        xArrow.position.set(axisLength, 0, 0);
        xArrow.rotation.z = -Math.PI / 2;
        axesGroup.add(xArrow);

        // Scene Y axis = model X / North (Red)
        const yAxisGeometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, axisLength, 0)
        ]);
        const yAxisMaterial = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 3 });
        const yAxis = new THREE.Line(yAxisGeometry, yAxisMaterial);
        axesGroup.add(yAxis);

        // North arrow
        const yArrowGeometry = new THREE.ConeGeometry(arrowSize * 0.5, arrowSize * 2, 8);
        const yArrowMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        const yArrow = new THREE.Mesh(yArrowGeometry, yArrowMaterial);
        yArrow.position.set(0, axisLength, 0);
        axesGroup.add(yArrow);

        // Z axis (Blue) - pointing DOWN (negative Z is depth)
        const zAxisGeometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, -axisLength)
        ]);
        const zAxisMaterial = new THREE.LineBasicMaterial({ color: 0x0088ff, linewidth: 3 });
        const zAxis = new THREE.Line(zAxisGeometry, zAxisMaterial);
        axesGroup.add(zAxis);

        // Z arrow
        const zArrowGeometry = new THREE.ConeGeometry(arrowSize * 0.5, arrowSize * 2, 8);
        const zArrowMaterial = new THREE.MeshBasicMaterial({ color: 0x0088ff });
        const zArrow = new THREE.Mesh(zArrowGeometry, zArrowMaterial);
        zArrow.position.set(0, 0, -axisLength);
        zArrow.rotation.x = Math.PI / 2;
        axesGroup.add(zArrow);

        // Add text labels using sprites
        this.addAxisLabel('Y (East)', labelDistance, 0, 0, 0x00ff00, axesGroup);
        this.addAxisLabel('X (North)', 0, labelDistance, 0, 0xff0000, axesGroup);
        this.addAxisLabel('Z (Depth)', 0, 0, -labelDistance, 0x0088ff, axesGroup);

        // Add distance labels - scene X carries the model Y extent and vice versa
        const eastLabel = `${(yExtent / 1000).toFixed(1)} km`;
        const northLabel = `${(xExtent / 1000).toFixed(1)} km`;
        const zLabel = `${(zExtent / 1000).toFixed(1)} km`;

        this.addAxisLabel(eastLabel, axisLength * 0.5, -arrowSize * 3, 0, 0x66ff66, axesGroup, 0.7);
        this.addAxisLabel(northLabel, -arrowSize * 3, axisLength * 0.5, 0, 0xff6666, axesGroup, 0.7);
        this.addAxisLabel(zLabel, -arrowSize * 3, 0, -axisLength * 0.5, 0x6666ff, axesGroup, 0.7);

        this.scene.add(axesGroup);
    }

    // Helper to create text labels as sprites
    addAxisLabel(text, x, y, z, color, parent, scale = 1.0) {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = 256;
        canvas.height = 128;

        // Draw text
        context.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
        context.font = 'bold 48px Arial';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, 128, 64);

        // Create sprite
        const texture = new THREE.CanvasTexture(canvas);
        const spriteMaterial = new THREE.SpriteMaterial({
            map: texture,
            transparent: true,
            depthTest: false,
            depthWrite: false
        });
        const sprite = new THREE.Sprite(spriteMaterial);
        sprite.position.set(x, y, z);
        sprite.scale.set(canvas.width * scale, canvas.height * scale, 1);

        parent.add(sprite);
    }

    // Add grid mesh to scene
    addGridToScene(gridData) {
        const { xCells, yCells, zCells } = gridData;

        // Scene axes follow the geographic convention used for MT models:
        //   model X = North -> scene Y,  model Y = East -> scene X,  depth -> -scene Z.
        // Feeding the cell arrays in this order is what keeps the picture oriented
        // like the model file. Mapping model X onto scene X instead gives a
        // left-handed (mirrored) frame, which reads as a 90 deg rotation of the grid.
        const xPositions = this.calculatePositions(yCells); // scene X = East  (model Y)
        const yPositions = this.calculatePositions(xCells); // scene Y = North (model X)
        const zPositions = this.calculatePositions(zCells);

        // Center the grid
        const xOffset = -(xPositions[xPositions.length - 1] / 2);
        const yOffset = -(yPositions[yPositions.length - 1] / 2);

        // Create wireframe geometry
        const geometry = new THREE.BufferGeometry();
        const vertices = [];
        const colors = [];

        // Helper to add colored line - CARTESIAN COORDS: (x, y, z) where Z is vertical
        const addLine = (p1, p2, color) => {
            vertices.push(...p1, ...p2);
            colors.push(...color, ...color);
        };

        // Color palette - brighter colors for better visibility
        const colorSurface = new THREE.Color(0x00ff88);      // Bright green for surface
        const colorPrimary = new THREE.Color(0x1A9FFF);      // Bright blue
        const colorSecondary = new THREE.Color(0x667eea);    // Medium blue
        const colorTertiary = new THREE.Color(0x444466);     // Dim blue
        const colorDepth = new THREE.Color(0xff4444);        // Red for deep layers

        // Calculate center region (where stations are) - indices follow the scene axes
        const centerXStart = Math.floor(yCells.length * 0.3);
        const centerXEnd = Math.floor(yCells.length * 0.7);
        const centerYStart = Math.floor(xCells.length * 0.3);
        const centerYEnd = Math.floor(xCells.length * 0.7);

        // Draw horizontal slices (XY planes at different depths)
        const layersToShow = [0, 1, 2, 5, 10, 15, 20, 30, 40, Math.floor(zCells.length * 0.8), zCells.length];

        for (const k of layersToShow) {
            if (k >= zPositions.length) continue;

            const z = -zPositions[k];  // Z is vertical (negative = down into earth)
            const depthRatio = k / zCells.length;
            const color = k === 0 ? colorSurface :
                         k <= 2 ? colorPrimary :
                         k <= 5 ? colorSecondary :
                         depthRatio > 0.7 ? colorDepth : colorTertiary;

            // X-direction lines (horizontal)
            for (let j = 0; j < yPositions.length; j++) {
                const y = yPositions[j] + yOffset;
                const lineColor = (j >= centerYStart && j <= centerYEnd) ? color :
                                 new THREE.Color(color.r * 0.4, color.g * 0.4, color.b * 0.4);

                addLine(
                    [xPositions[0] + xOffset, y, z],
                    [xPositions[xPositions.length - 1] + xOffset, y, z],
                    [lineColor.r, lineColor.g, lineColor.b]
                );
            }

            // Y-direction lines (horizontal)
            for (let i = 0; i < xPositions.length; i++) {
                const x = xPositions[i] + xOffset;
                const lineColor = (i >= centerXStart && i <= centerXEnd) ? color :
                                 new THREE.Color(color.r * 0.4, color.g * 0.4, color.b * 0.4);

                addLine(
                    [x, yPositions[0] + yOffset, z],
                    [x, yPositions[yPositions.length - 1] + yOffset, z],
                    [lineColor.r, lineColor.g, lineColor.b]
                );
            }
        }

        // Z-direction lines (vertical) - from surface down
        const step = Math.max(1, Math.floor(Math.min(xCells.length, yCells.length) / 20));

        for (let i = 0; i < xPositions.length; i += step) {
            for (let j = 0; j < yPositions.length; j += step) {
                const x = xPositions[i] + xOffset;
                const y = yPositions[j] + yOffset;

                const inCenter = (i >= centerXStart && i <= centerXEnd &&
                                 j >= centerYStart && j <= centerYEnd);

                const color = inCenter ? colorPrimary : colorTertiary;
                const opacity = inCenter ? 1.0 : 0.3;

                // Vertical line from surface (z=0) to bottom (z=-depth)
                addLine(
                    [x, y, 0],
                    [x, y, -zPositions[zPositions.length - 1]],
                    [color.r * opacity, color.g * opacity, color.b * opacity]
                );
            }
        }

        // Add vertical grid planes (XZ and YZ planes)
        // XZ planes (constant Y) - show front and back faces
        const ySlices = [0, Math.floor(yPositions.length / 4), Math.floor(yPositions.length / 2),
                        Math.floor(yPositions.length * 3 / 4), yPositions.length - 1];

        for (const j of ySlices) {
            const y = yPositions[j] + yOffset;
            const isEdge = (j === 0 || j === yPositions.length - 1);
            const planeColor = isEdge ? colorPrimary : colorTertiary;
            const planeOpacity = isEdge ? 0.6 : 0.2;

            // Vertical lines in X direction
            const xStepPlane = Math.max(1, Math.floor(xPositions.length / 15));
            for (let i = 0; i < xPositions.length; i += xStepPlane) {
                const x = xPositions[i] + xOffset;
                addLine(
                    [x, y, 0],
                    [x, y, -zPositions[zPositions.length - 1]],
                    [planeColor.r * planeOpacity, planeColor.g * planeOpacity, planeColor.b * planeOpacity]
                );
            }

            // Horizontal lines in Z direction
            const zStepPlane = Math.max(1, Math.floor(zPositions.length / 12));
            for (let k = 0; k < zPositions.length; k += zStepPlane) {
                const z = -zPositions[k];
                addLine(
                    [xPositions[0] + xOffset, y, z],
                    [xPositions[xPositions.length - 1] + xOffset, y, z],
                    [planeColor.r * planeOpacity, planeColor.g * planeOpacity, planeColor.b * planeOpacity]
                );
            }
        }

        // YZ planes (constant X) - show left and right faces
        const xSlices = [0, Math.floor(xPositions.length / 4), Math.floor(xPositions.length / 2),
                        Math.floor(xPositions.length * 3 / 4), xPositions.length - 1];

        for (const i of xSlices) {
            const x = xPositions[i] + xOffset;
            const isEdge = (i === 0 || i === xPositions.length - 1);
            const planeColor = isEdge ? colorPrimary : colorTertiary;
            const planeOpacity = isEdge ? 0.6 : 0.2;

            // Vertical lines in Y direction
            const yStepPlane = Math.max(1, Math.floor(yPositions.length / 15));
            for (let j = 0; j < yPositions.length; j += yStepPlane) {
                const y = yPositions[j] + yOffset;
                addLine(
                    [x, y, 0],
                    [x, y, -zPositions[zPositions.length - 1]],
                    [planeColor.r * planeOpacity, planeColor.g * planeOpacity, planeColor.b * planeOpacity]
                );
            }

            // Horizontal lines in Z direction
            const zStepPlane = Math.max(1, Math.floor(zPositions.length / 12));
            for (let k = 0; k < zPositions.length; k += zStepPlane) {
                const z = -zPositions[k];
                addLine(
                    [x, yPositions[0] + yOffset, z],
                    [x, yPositions[yPositions.length - 1] + yOffset, z],
                    [planeColor.r * planeOpacity, planeColor.g * planeOpacity, planeColor.b * planeOpacity]
                );
            }
        }

        // Add boundary box
        const maxX = xPositions[xPositions.length - 1] + xOffset;
        const minX = xPositions[0] + xOffset;
        const maxY = yPositions[yPositions.length - 1] + yOffset;
        const minY = yPositions[0] + yOffset;
        const maxZ = 0;
        const minZ = -zPositions[zPositions.length - 1];

        const boxColor = colorPrimary;
        const box = [
            [[minX, minY, maxZ], [maxX, minY, maxZ]],
            [[maxX, minY, maxZ], [maxX, maxY, maxZ]],
            [[maxX, maxY, maxZ], [minX, maxY, maxZ]],
            [[minX, maxY, maxZ], [minX, minY, maxZ]],
            [[minX, minY, minZ], [maxX, minY, minZ]],
            [[maxX, minY, minZ], [maxX, maxY, minZ]],
            [[maxX, maxY, minZ], [minX, maxY, minZ]],
            [[minX, maxY, minZ], [minX, minY, minZ]],
            [[minX, minY, maxZ], [minX, minY, minZ]],
            [[maxX, minY, maxZ], [maxX, minY, minZ]],
            [[maxX, maxY, maxZ], [maxX, maxY, minZ]],
            [[minX, maxY, maxZ], [minX, maxY, minZ]]
        ];

        box.forEach(([p1, p2]) => {
            addLine(p1, p2, [boxColor.r, boxColor.g, boxColor.b]);
        });

        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

        const material = new THREE.LineBasicMaterial({
            vertexColors: true,
            linewidth: 2,
            transparent: true,
            opacity: 0.6  // Make lines more transparent (0.0 = fully transparent, 1.0 = opaque)
        });

        this.gridMesh = new THREE.LineSegments(geometry, material);
        this.scene.add(this.gridMesh);

        // Add semi-transparent surface plane at Z=0 (Cartesian coords)
        const planeGeometry = new THREE.PlaneGeometry(
            xPositions[xPositions.length - 1],
            yPositions[yPositions.length - 1]
        );
        const planeMaterial = new THREE.MeshPhongMaterial({
            color: 0x1a3a4a,
            transparent: true,
            opacity: 0.15,
            side: THREE.DoubleSide,
            shininess: 30
        });
        const plane = new THREE.Mesh(planeGeometry, planeMaterial);
        // No rotation needed - plane is already in XY plane with camera.up = (0,0,1)
        plane.position.z = 0;
        this.scene.add(plane);
    }

    // Calculate cumulative positions
    calculatePositions(cells) {
        const positions = [0];
        let cumulative = 0;
        for (const cell of cells) {
            cumulative += cell;
            positions.push(cumulative);
        }
        return positions;
    }

    // Download generated file
    downloadCoarse(filename = 'Coarse.dat') {
        if (!this.generatedCoarse) {
            throw new Error('No coarse data generated yet');
        }

        const blob = new Blob([this.generatedCoarse.content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    // Get generated coarse as File object
    getCoarseAsFile(filename = 'Coarse.dat') {
        if (!this.generatedCoarse) {
            throw new Error('No coarse data generated yet');
        }

        return new File([this.generatedCoarse.content], filename, { type: 'text/plain' });
    }

    // Clean up
    dispose() {
        if (this.renderer) {
            this.renderer.dispose();
        }
        if (this.controls) {
            this.controls.dispose();
        }
        if (this.gridMesh) {
            this.gridMesh.geometry.dispose();
            this.gridMesh.material.dispose();
        }
        if (this.resizeHandler) {
            window.removeEventListener('resize', this.resizeHandler);
        }
    }
}
