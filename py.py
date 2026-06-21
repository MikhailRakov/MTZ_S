from pathlib import Path

# Укажи здесь папки, которые нужно обработать (относительно текущей директории или абсолютные)
FOLDERS_TO_SCAN = [
    "cmd",        # пример: папка frontend в текущей директории
    "front",     # пример: вложенная папка
    "internal",       # можно даже выйти за пределы (относительный путь)
    # Добавляй сколько нужно
]

# Поддерживаемые расширения
SUPPORTED_EXTENSIONS = {".html", ".js", ".go"}

def make_safe_filename(path: str) -> str:
    """Заменяет недопустимые символы в имени файла на подчёркивания"""
    replacements = str.maketrans({
        '<': '_', '>': '_', ':': '_', '"': '_',
        '/': '_', '\\': '_', '|': '_', '?': '_', '*': '_'
    })
    return path.translate(replacements)

def process_folder(root_folder: Path, txts_dir: Path, base_dir: Path):
    """Рекурсивно обходит одну папку и сохраняет подходящие файлы"""
    if not root_folder.exists():
        print(f"Папка не найдена: {root_folder}")
        return

    for file_path in root_folder.rglob("*"):
        if file_path.is_file() and file_path.suffix.lower() in SUPPORTED_EXTENSIONS:
            # Относительный путь от base_dir (для красивого имени)
            try:
                rel_path = file_path.relative_to(base_dir)
            except ValueError:
                # Если файл вне base_dir (например, ../shared), используем относительный путь от корня сканирования
                rel_path = file_path.relative_to(file_path.anchor)  # fallback
            safe_name = make_safe_filename(str(rel_path.with_suffix('')))
            txt_path = txts_dir / (safe_name + ".txt")

            try:
                with open(file_path, 'r', encoding='utf-8', errors='replace') as f:
                    content = f.read()
                with open(txt_path, 'w', encoding='utf-8') as f:
                    f.write(content)
                print(f"Сохранён: {rel_path} → {txt_path.name}")
            except Exception as e:
                print(f"Ошибка при обработке {file_path}: {e}")

def main():
    current_dir = Path.cwd()
    txts_dir = current_dir / "txts"
    txts_dir.mkdir(exist_ok=True)

    # Определяем "базовую" директорию для относительных путей.
    # Чтобы пути были читаемыми, лучше использовать общего родителя.
    # В простом случае — текущая директория.
    base_dir = current_dir

    for folder in FOLDERS_TO_SCAN:
        folder_path = Path(folder)
        # Если путь относительный — делаем относительно текущей директории
        if not folder_path.is_absolute():
            folder_path = current_dir / folder_path
        process_folder(folder_path.resolve(), txts_dir, base_dir)

if __name__ == "__main__":
    main()