import os

def generate_tree_structure(root_dir, prefix="", is_last=True, output_lines=None, exclude_dirs=None):
    if output_lines is None:
        output_lines = []
    if exclude_dirs is None:
        exclude_dirs = set()

    if prefix == "":
        # Корневая строка
        root_name = os.path.basename(os.path.abspath(root_dir))
        output_lines.append(f"{root_name}/")

    try:
        entries = os.listdir(root_dir)
    except PermissionError:
        entries = []

    # Фильтруем исключения
    filtered_entries = []
    for entry in entries:
        if entry in exclude_dirs:
            continue
        # Также можно игнорировать скрытые файлы/папки (опционально)
        # if entry.startswith('.'):
        #     continue
        filtered_entries.append(entry)

    # Сортируем: сначала папки, потом файлы
    dirs = []
    files = []
    for entry in filtered_entries:
        full_path = os.path.join(root_dir, entry)
        if os.path.isdir(full_path):
            dirs.append(entry)
        else:
            files.append(entry)

    dirs.sort()
    files.sort()
    all_entries = dirs + files
    total = len(all_entries)

    for i, entry in enumerate(all_entries):
        is_last_entry = (i == total - 1)
        full_path = os.path.join(root_dir, entry)

        if is_last_entry:
            current_prefix = "└── "
            next_prefix = "    "
        else:
            current_prefix = "├── "
            next_prefix = "│   "

        if os.path.isdir(full_path):
            output_lines.append(prefix + current_prefix + entry + "/")
            generate_tree_structure(
                full_path,
                prefix=prefix + next_prefix,
                is_last=is_last_entry,
                output_lines=output_lines,
                exclude_dirs=exclude_dirs
            )
        else:
            output_lines.append(prefix + current_prefix + entry)

    return output_lines

def save_tree_to_file(root_dir, output_file="structure.txt", exclude_dirs=None):
    if exclude_dirs is None:
        exclude_dirs = set()
    else:
        exclude_dirs = set(exclude_dirs)  # для быстрой проверки

    tree_lines = generate_tree_structure(root_dir, exclude_dirs=exclude_dirs)
    with open(output_file, "w", encoding="utf-8") as f:
        f.write("\n".join(tree_lines))
    print(f"Структура сохранена в {output_file}")

# Пример использования:
if __name__ == "__main__":
    project_root = "F:/3dMTZInversionService/3DMTZInversionService"  # Укажите путь к вашему проекту

    # Укажите папки и/или файлы, которые нужно исключить
    exclude = {
        ".git",
        ".vscode",
        "__pycache__",
        "txts",
        "node_modules",
        ".idea",
        ".DS_Store",
        "venv",
        "dist",
        "build",
        ".gitattributes",
        ".gitignore",
        "README.md",
        "py.py",
        "serviceAccountKey.json",
        "st.py",
        "structure.txt",

    }

    save_tree_to_file(project_root, "structure.txt", exclude_dirs=exclude)