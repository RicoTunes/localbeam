class FileItem {
  final String name;
  final String path;
  final String type; // 'file' or 'directory'
  final int size;
  final double modified;
  final String extension;

  const FileItem({
    required this.name,
    required this.path,
    required this.type,
    required this.size,
    required this.modified,
    required this.extension,
  });

  bool get isDirectory => type == 'directory';

  factory FileItem.fromJson(Map<String, dynamic> json) {
    return FileItem(
      name: json['name'] as String? ?? '',
      path: json['path'] as String? ?? '',
      type: json['type'] as String? ?? 'file',
      size: (json['size'] as num?)?.toInt() ?? 0,
      modified: (json['modified'] as num?)?.toDouble() ?? 0,
      extension: json['extension'] as String? ?? '',
    );
  }
}

class BrowseResult {
  final List<FileItem> items;
  final String currentPath;
  final int totalFiles;
  final int totalSize;

  const BrowseResult({
    required this.items,
    required this.currentPath,
    required this.totalFiles,
    required this.totalSize,
  });

  factory BrowseResult.fromJson(Map<String, dynamic> json) {
    final raw = json['files'] as List<dynamic>? ?? [];
    return BrowseResult(
      items: raw.map((e) => FileItem.fromJson(e as Map<String, dynamic>)).toList(),
      currentPath: json['path'] as String? ?? '',
      totalFiles: (json['total_files'] as num?)?.toInt() ?? raw.length,
      totalSize: (json['total_size'] as num?)?.toInt() ?? 0,
    );
  }
}
