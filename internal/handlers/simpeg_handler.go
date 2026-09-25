package handlers

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/julienschmidt/httprouter"
)

func RegisterSimpegRoutes(router *httprouter.Router) {
	router.POST("/mtz/simpeg/upload", handleSimpegUpload)
	router.GET("/mtz/simpeg/upload", handleSimpegForm)
}

func handleSimpegForm(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	http.ServeFile(w, r, "/app/front/simpeg_converter.html")
}

func handleSimpegUpload(w http.ResponseWriter, r *http.Request, _ httprouter.Params) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	file, header, err := r.FormFile("npz")
	if err != nil {
		http.Error(w, "npz file required", http.StatusBadRequest)
		return
	}
	defer file.Close()

	dir := "/tmp/simpeg_upload"
	os.MkdirAll(dir, 0755)

	inPath := filepath.Join(dir, header.Filename)
	outFile, _ := os.Create(inPath)
	io.Copy(outFile, file)
	outFile.Close()

	cmd := exec.Command("python3", "/home/temp/Desktop/MTZ/MTZ_S/simpeg_test/convert_simpeg_to_service.py")
	cmd.Env = append(os.Environ(),
		"PYTHONPATH=/home/temp/Desktop/MTZ/MTZ_S/simpeg_test/libs",
		"MPLCONFIGDIR=/tmp",
	)
	cmd.Dir = "/home/temp/Desktop/MTZ/MTZ_S/simpeg_test"
	//out _ := cmd.CombinedOutput()

	// Read results
	res := map[string]interface{}{"status": "converted", "output_dir": "/home/temp/Desktop/MTZ/MTZ_S/simpeg_test/output"}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(res)
}
