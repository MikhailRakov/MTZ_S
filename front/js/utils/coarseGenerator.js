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
        const stations = new Set();
        const periods = new Set();
        const xCoords = [];
        const yCoords = [];

        for (const line of lines) {
            if (line.trim().startsWith('#') || line.trim().startsWith('>') || !line.trim()) continue;

            const parts = line.trim().split(/\s+/);
            if (parts.length >= 7) {
                const period = parseFloat(parts[0]);
                const code = parts[1];
                const x = parseFloat(parts[4]);
                const y = parseFloat(parts[5]);

                if (!isNaN(period) && !isNaN(x) && !isNaN(y)) {
                    periods.add(period);
                    stations.add(code);
                    xCoords.push(x);
                    yCoords.push(y);
                }
            }
        }

        return {
            numStations: stations.size,
            numPeriods: periods.size,
            xMin: Math.min(...xCoords),
            xMax: Math.max(...xCoords),
            yMin: Math.min(...yCoords),
            yMax: Math.max(...yCoords),
            xRange: Math.max(...xCoords) - Math.min(...xCoords),
            yRange: Math.max(...yCoords) - Math.min(...yCoords),
            stations: Array.from(stations),
            periods: Array.from(periods).sort((a, b) => a - b)
        };
    }

    // Generate X/Y cells with padding and growth
    generateXYCells(min, max, nCells, padding = 1.2, growthFactor = 1.15, minCellSize = 30000) {
        const range = max - min;
        const paddedRange = range * padding;
        const nHalf = Math.floor(nCells / 2);

        const coreSize = Math.max(range / (nHalf * 1.5), minCellSize);
        const cells = [];

        // Left/bottom padding cells (growing)
        for (let i = 0; i < nHalf; i++) {
            const size = coreSize * Math.pow(growthFactor, nHalf - i);
            cells.push(size);
        }

        // Right/top padding cells (growing)
        for (let i = 0; i < nCells - nHalf; i++) {
            const size = coreSize * Math.pow(growthFactor, i);
            cells.push(size);
        }

        return cells;
    }

    // Generate Z cells with exponential growth
    generateZCells(nZ, firstLayer = 500, growthFactor = 1.15) {
        const cells = [];
        let currentSize = firstLayer;

        for (let i = 0; i < nZ; i++) {
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

        // X cells
        content += xCells.map(v => v.toFixed(2)).join(' ') + '\n';

        // Y cells
        content += yCells.map(v => v.toFixed(2)).join(' ') + '\n';

        // Z cells
        content += zCells.map(v => v.toFixed(2)).join(' ') + '\n';

        // Resistivity values (default rho for all cells)
        const rhoFormatted = config.defaultRho.toExponential(5).toUpperCase().replace('E', 'E+');

        for (let z = 0; z < config.nZ; z++) {
            const row = Array(config.nX).fill(rhoFormatted).join(' ');
            content += row + '\n';
        }

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

        const content = this.buildCoarseContent(config, xCells, yCells, zCells);

        this.generatedCoarse = {
            content,
            xCells,
            yCells,
            zCells,
            config,
            stats: profilesStats
        };

        return this.generatedCoarse;
    }

    // Initialize 3D visualization
    init3DVisualization(containerElement, gridData) {
        const width = containerElement.clientWidth;
        const height = containerElement.clientHeight;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a1d);
        this.scene.fog = new THREE.Fog(0x1a1a1d, 1000, 10000);

        // Camera
        this.camera = new THREE.PerspectiveCamera(60, width / height, 1, 50000);
        this.camera.position.set(5000, 4000, 5000);
        this.camera.lookAt(0, 0, 0);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        containerElement.innerHTML = '';
        containerElement.appendChild(this.renderer.domElement);

        // Controls
        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.maxDistance = 30000;
        this.controls.minDistance = 500;

        // Lights
        const ambientLight = new THREE.AmbientLight(0x404040, 1);
        this.scene.add(ambientLight);

        const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight1.position.set(1, 1, 1);
        this.scene.add(directionalLight1);

        const directionalLight2 = new THREE.DirectionalLight(0x1A9FFF, 0.4);
        directionalLight2.position.set(-1, -0.5, -1);
        this.scene.add(directionalLight2);

        // Add grid
        this.addGridToScene(gridData);

        // Add axes helper
        const axesHelper = new THREE.AxesHelper(2000);
        this.scene.add(axesHelper);

        // Animation loop
        const animate = () => {
            requestAnimationFrame(animate);
            this.controls.update();
            this.renderer.render(this.scene, this.camera);
        };
        animate();

        // Handle resize
        window.addEventListener('resize', () => {
            const newWidth = containerElement.clientWidth;
            const newHeight = containerElement.clientHeight;
            this.camera.aspect = newWidth / newHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(newWidth, newHeight);
        });
    }

    // Add grid mesh to scene
    addGridToScene(gridData) {
        const { xCells, yCells, zCells } = gridData;

        // Calculate positions
        const xPositions = this.calculatePositions(xCells);
        const yPositions = this.calculatePositions(yCells);
        const zPositions = this.calculatePositions(zCells);

        // Center the grid
        const xOffset = -(xPositions[xPositions.length - 1] / 2);
        const yOffset = -(yPositions[yPositions.length - 1] / 2);

        // Create wireframe geometry
        const geometry = new THREE.BufferGeometry();
        const vertices = [];
        const colors = [];

        // Helper to add colored line
        const addLine = (p1, p2, color) => {
            vertices.push(...p1, ...p2);
            colors.push(...color, ...color);
        };

        // Color palette
        const colorPrimary = new THREE.Color(0x1A9FFF);
        const colorSecondary = new THREE.Color(0x3367D6);
        const colorTertiary = new THREE.Color(0x667eea);

        // Draw grid lines
        // X-direction lines
        for (let j = 0; j <= yCells.length; j++) {
            for (let k = 0; k <= zCells.length; k++) {
                const y = (j < yPositions.length ? yPositions[j] : yPositions[yPositions.length - 1]) + yOffset;
                const z = -(k < zPositions.length ? zPositions[k] : zPositions[zPositions.length - 1]);

                const color = k === 0 ? colorPrimary : (k % 5 === 0 ? colorSecondary : colorTertiary);

                addLine(
                    [xPositions[0] + xOffset, y, z],
                    [xPositions[xPositions.length - 1] + xOffset, y, z],
                    [color.r, color.g, color.b]
                );
            }
        }

        // Y-direction lines
        for (let i = 0; i <= xCells.length; i++) {
            for (let k = 0; k <= zCells.length; k++) {
                const x = (i < xPositions.length ? xPositions[i] : xPositions[xPositions.length - 1]) + xOffset;
                const z = -(k < zPositions.length ? zPositions[k] : zPositions[zPositions.length - 1]);

                const color = k === 0 ? colorPrimary : (k % 5 === 0 ? colorSecondary : colorTertiary);

                addLine(
                    [x, yPositions[0] + yOffset, z],
                    [x, yPositions[yPositions.length - 1] + yOffset, z],
                    [color.r, color.g, color.b]
                );
            }
        }

        // Z-direction lines (vertical)
        for (let i = 0; i <= xCells.length; i++) {
            for (let j = 0; j <= yCells.length; j++) {
                const x = (i < xPositions.length ? xPositions[i] : xPositions[xPositions.length - 1]) + xOffset;
                const y = (j < yPositions.length ? yPositions[j] : yPositions[yPositions.length - 1]) + yOffset;

                const color = (i % 5 === 0 && j % 5 === 0) ? colorSecondary : colorTertiary;

                addLine(
                    [x, y, 0],
                    [x, y, -zPositions[zPositions.length - 1]],
                    [color.r, color.g, color.b]
                );
            }
        }

        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

        const material = new THREE.LineBasicMaterial({
            vertexColors: true,
            transparent: true,
            opacity: 0.7
        });

        this.gridMesh = new THREE.LineSegments(geometry, material);
        this.scene.add(this.gridMesh);

        // Add surface plane
        const planeGeometry = new THREE.PlaneGeometry(
            xPositions[xPositions.length - 1],
            yPositions[yPositions.length - 1]
        );
        const planeMaterial = new THREE.MeshBasicMaterial({
            color: 0x2b2b31,
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide
        });
        const plane = new THREE.Mesh(planeGeometry, planeMaterial);
        plane.rotation.x = -Math.PI / 2;
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
    }
}
