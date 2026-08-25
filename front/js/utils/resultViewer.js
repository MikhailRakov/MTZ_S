// 3D Result Viewer for MTZ Inversion Results
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class ResultViewer {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.modelMesh = null;
        this.colorScale = null;
        this.modelData = null;
    }

    // Parse result file (assuming ModEM/MT3D format)
    parseResultFile(fileContent) {
        const lines = fileContent.split('\n');
        let lineIndex = 0;

        // Skip header
        while (lineIndex < lines.length && !lines[lineIndex].trim().match(/^\d+\s+\d+\s+\d+/)) {
            lineIndex++;
        }

        if (lineIndex >= lines.length) {
            throw new Error('Invalid file format: grid dimensions not found');
        }

        // Parse grid dimensions
        const dimParts = lines[lineIndex].trim().split(/\s+/);
        const nX = parseInt(dimParts[0]);
        const nY = parseInt(dimParts[1]);
        const nZ = parseInt(dimParts[2]);
        lineIndex++;

        console.log(`Grid dimensions: ${nX} x ${nY} x ${nZ}`);

        // Parse X cells
        const xCells = [];
        while (xCells.length < nX && lineIndex < lines.length) {
            const parts = lines[lineIndex].trim().split(/\s+/);
            xCells.push(...parts.map(v => parseFloat(v)));
            lineIndex++;
        }

        // Parse Y cells
        const yCells = [];
        while (yCells.length < nY && lineIndex < lines.length) {
            const parts = lines[lineIndex].trim().split(/\s+/);
            yCells.push(...parts.map(v => parseFloat(v)));
            lineIndex++;
        }

        // Parse Z cells
        const zCells = [];
        while (zCells.length < nZ && lineIndex < lines.length) {
            const parts = lines[lineIndex].trim().split(/\s+/);
            zCells.push(...parts.map(v => parseFloat(v)));
            lineIndex++;
        }

        // Parse resistivity values
        const rhoValues = [];
        while (rhoValues.length < nX * nY * nZ && lineIndex < lines.length) {
            const line = lines[lineIndex].trim();
            if (!line || line.startsWith('#')) {
                lineIndex++;
                continue;
            }
            const parts = line.split(/\s+/);
            for (const part of parts) {
                if (part) {
                    const value = parseFloat(part);
                    if (!isNaN(value)) {
                        rhoValues.push(value);
                    }
                }
            }
            lineIndex++;
        }

        console.log(`Parsed ${rhoValues.length} resistivity values`);

        return {
            nX, nY, nZ,
            xCells, yCells, zCells,
            rhoValues
        };
    }

    // Initialize 3D visualization
    init3DVisualization(containerElement, modelData) {
        this.modelData = modelData;

        const width = containerElement.clientWidth;
        const height = containerElement.clientHeight;

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x0a0a0f);

        // Calculate extents
        const xExtent = modelData.xCells.reduce((a, b) => a + b, 0);
        const yExtent = modelData.yCells.reduce((a, b) => a + b, 0);
        const zExtent = modelData.zCells.reduce((a, b) => a + b, 0);
        const maxExtent = Math.max(xExtent, yExtent, zExtent);

        // Camera
        this.camera = new THREE.PerspectiveCamera(50, width / height, maxExtent * 0.01, maxExtent * 10);
        const cameraDistance = maxExtent * 1.8;
        this.camera.position.set(cameraDistance * 0.8, cameraDistance * 0.8, cameraDistance * 1.0);
        this.camera.lookAt(0, 0, -zExtent * 0.3);
        this.camera.up.set(0, 0, 1);

        // Renderer
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

        // Lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight1.position.set(1, 1, 1);
        this.scene.add(directionalLight1);

        const directionalLight2 = new THREE.DirectionalLight(0x4a90e2, 0.4);
        directionalLight2.position.set(-1, -1, 0.5);
        this.scene.add(directionalLight2);

        // Add model visualization
        this.addModelToScene(modelData);

        // Add color scale legend
        this.addColorScale(containerElement);

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
        this.resizeHandler = handleResize;
    }

    // Add 3D model to scene
    addModelToScene(modelData) {
        const { nX, nY, nZ, xCells, yCells, zCells, rhoValues } = modelData;

        // Scene axes follow the geographic convention used for MT models:
        //   model X = North -> scene Y,  model Y = East -> scene X,  depth -> -scene Z.
        // Mapping model X onto scene X instead gives a left-handed (mirrored) frame,
        // which reads as a 90 deg rotation of the model.
        const eastPositions = this.calculatePositions(yCells);   // scene X
        const northPositions = this.calculatePositions(xCells);  // scene Y
        const zPositions = this.calculatePositions(zCells);

        // Center the grid
        const eastOffset = -(eastPositions[eastPositions.length - 1] / 2);
        const northOffset = -(northPositions[northPositions.length - 1] / 2);

        // Calculate resistivity range for color mapping
        const validRho = rhoValues.filter(v => v > 0);
        const minRho = Math.min(...validRho);
        const maxRho = Math.max(...validRho);
        const logMinRho = Math.log10(minRho);
        const logMaxRho = Math.log10(maxRho);

        console.log(`Resistivity range: ${minRho.toFixed(2)} - ${maxRho.toFixed(2)} Ω·m`);

        // Create geometry for cells
        const geometry = new THREE.BufferGeometry();
        const vertices = [];
        const colors = [];

        // Sample cells for visualization (show only some layers and subsample XY)
        const xStep = Math.max(1, Math.floor(nX / 30));
        const yStep = Math.max(1, Math.floor(nY / 30));
        const zLayers = [0, 2, 5, 10, 15, 20, 30, Math.floor(nZ * 0.7), Math.floor(nZ - 1)];

        for (const k of zLayers) {
            if (k >= nZ) continue;

            for (let i = 0; i < nX; i += xStep) {
                for (let j = 0; j < nY; j += yStep) {
                    const index = k * nX * nY + j * nX + i;
                    if (index >= rhoValues.length) continue;

                    const rho = rhoValues[index];
                    if (rho <= 0) continue;

                    // Cell boundaries: i indexes model X (North, scene Y),
                    // j indexes model Y (East, scene X)
                    const x1 = eastPositions[j] + eastOffset;
                    const x2 = eastPositions[j + 1] + eastOffset;
                    const y1 = northPositions[i] + northOffset;
                    const y2 = northPositions[i + 1] + northOffset;
                    const z1 = -zPositions[k];
                    const z2 = -zPositions[k + 1];

                    // Get color for this resistivity value
                    const color = this.getColorForResistivity(rho, logMinRho, logMaxRho);

                    // Create cube wireframe
                    this.addCubeWireframe(vertices, colors, x1, x2, y1, y2, z1, z2, color);
                }
            }
        }

        geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));

        const material = new THREE.LineBasicMaterial({
            vertexColors: true,
            linewidth: 1,
            transparent: true,
            opacity: 0.7
        });

        this.modelMesh = new THREE.LineSegments(geometry, material);
        this.scene.add(this.modelMesh);

        // Store range for color scale
        this.colorScale = { minRho, maxRho, logMinRho, logMaxRho };
    }

    // Add cube wireframe
    addCubeWireframe(vertices, colors, x1, x2, y1, y2, z1, z2, color) {
        const addLine = (p1, p2) => {
            vertices.push(...p1, ...p2);
            colors.push(...color, ...color);
        };

        // Bottom face
        addLine([x1, y1, z1], [x2, y1, z1]);
        addLine([x2, y1, z1], [x2, y2, z1]);
        addLine([x2, y2, z1], [x1, y2, z1]);
        addLine([x1, y2, z1], [x1, y1, z1]);

        // Top face
        addLine([x1, y1, z2], [x2, y1, z2]);
        addLine([x2, y1, z2], [x2, y2, z2]);
        addLine([x2, y2, z2], [x1, y2, z2]);
        addLine([x1, y2, z2], [x1, y1, z2]);

        // Vertical edges (only some for clarity)
        if (Math.random() > 0.7) {
            addLine([x1, y1, z1], [x1, y1, z2]);
            addLine([x2, y2, z1], [x2, y2, z2]);
        }
    }

    // Get color for resistivity value (logarithmic scale)
    getColorForResistivity(rho, logMinRho, logMaxRho) {
        const logRho = Math.log10(rho);
        const t = (logRho - logMinRho) / (logMaxRho - logMinRho);

        // Color scale: blue (conductive) -> green -> yellow -> red (resistive)
        let r, g, b;
        if (t < 0.25) {
            // Blue to Cyan
            const t2 = t / 0.25;
            r = 0;
            g = t2 * 0.5;
            b = 1;
        } else if (t < 0.5) {
            // Cyan to Green
            const t2 = (t - 0.25) / 0.25;
            r = 0;
            g = 0.5 + t2 * 0.5;
            b = 1 - t2;
        } else if (t < 0.75) {
            // Green to Yellow
            const t2 = (t - 0.5) / 0.25;
            r = t2;
            g = 1;
            b = 0;
        } else {
            // Yellow to Red
            const t2 = (t - 0.75) / 0.25;
            r = 1;
            g = 1 - t2;
            b = 0;
        }

        return [r, g, b];
    }

    // Add color scale legend
    addColorScale(containerElement) {
        if (!this.colorScale) return;

        const legend = document.createElement('div');
        legend.className = 'result-viewer-legend';
        legend.innerHTML = `
            <div class="legend-title">Удельное сопротивление (Ω·м)</div>
            <div class="color-scale-bar"></div>
            <div class="color-scale-labels">
                <span>${this.colorScale.minRho.toFixed(1)}</span>
                <span>${Math.sqrt(this.colorScale.minRho * this.colorScale.maxRho).toFixed(1)}</span>
                <span>${this.colorScale.maxRho.toFixed(1)}</span>
            </div>
        `;

        // Add gradient to color bar
        const colorBar = legend.querySelector('.color-scale-bar');
        colorBar.style.background = 'linear-gradient(to right, #0000ff, #00ff00, #ffff00, #ff0000)';

        containerElement.appendChild(legend);
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

    // Cleanup
    dispose() {
        if (this.renderer) {
            this.renderer.dispose();
        }
        if (this.controls) {
            this.controls.dispose();
        }
        if (this.modelMesh) {
            this.modelMesh.geometry.dispose();
            this.modelMesh.material.dispose();
        }
        if (this.resizeHandler) {
            window.removeEventListener('resize', this.resizeHandler);
        }
    }
}
