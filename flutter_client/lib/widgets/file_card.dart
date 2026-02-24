import 'package:flutter/material.dart';
import '../models/file_item.dart';

class FileCard extends StatelessWidget {
  final FileItem item;
  final VoidCallback onTap;
  final VoidCallback? onDownload;

  const FileCard({
    super.key,
    required this.item,
    required this.onTap,
    this.onDownload,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return GestureDetector(
      onTap: onTap,
      child: Container(
        margin: const EdgeInsets.only(bottom: 8),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
        decoration: BoxDecoration(
          color: isDark ? const Color(0xFF1E293B) : Colors.white,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(
            color: isDark
                ? Colors.white.withOpacity(.06)
                : Colors.black.withOpacity(.05),
          ),
        ),
        child: Row(
          children: [
            // Icon bubble
            _FileIconBubble(item: item),
            const SizedBox(width: 12),
            // Name + sub-info
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: Text(
                          item.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontWeight: FontWeight.w600,
                            fontSize: 14,
                          ),
                        ),
                      ),
                      if (!item.isDirectory)
                        _TypeBadge(item.extension?.toUpperCase() ?? '?'),
                    ],
                  ),
                  const SizedBox(height: 3),
                  Text(
                    _subText(),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11.5,
                      color: Colors.grey.withOpacity(.55),
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            // Trailing action
            if (item.isDirectory)
              Icon(Icons.chevron_right_rounded,
                  color: Colors.grey.withOpacity(.4), size: 20)
            else
              GestureDetector(
                onTap: onDownload,
                child: Container(
                  width: 33,
                  height: 33,
                  decoration: BoxDecoration(
                    gradient: const LinearGradient(
                      colors: [Color(0xFF22C55E), Color(0xFF16A34A)],
                      begin: Alignment.topLeft,
                      end: Alignment.bottomRight,
                    ),
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child: const Icon(Icons.download_rounded,
                      color: Colors.white, size: 18),
                ),
              ),
          ],
        ),
      ),
    );
  }

  String _subText() {
    if (item.isDirectory) return 'Folder';
    final parts = <String>[];
    if (item.size > 0) parts.add(_formatSize(item.size));
    if (item.modified > 0) parts.add(_formatDate(item.modified));
    return parts.isNotEmpty ? parts.join(' · ') : '';
  }

  String _formatSize(int bytes) {
    if (bytes < 1024) return '${bytes}B';
    if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)}KB';
    if (bytes < 1024 * 1024 * 1024) {
      return '${(bytes / 1024 / 1024).toStringAsFixed(1)}MB';
    }
    return '${(bytes / 1024 / 1024 / 1024).toStringAsFixed(2)}GB';
  }

  String _formatDate(double unixTimestamp) {
    try {
      final dt = DateTime.fromMillisecondsSinceEpoch(
          (unixTimestamp * 1000).toInt());
      final now = DateTime.now();
      final diff = now.difference(dt).inDays;
      if (diff == 0) return 'Today';
      if (diff == 1) return 'Yesterday';
      if (diff < 7) return '$diff days ago';
      return '${dt.month}/${dt.day}/${dt.year % 100}';
    } catch (_) {
      return '';
    }
  }
}

// ── Icon Bubble ───────────────────────────────────────────────────────────

class _FileIconBubble extends StatelessWidget {
  final FileItem item;
  const _FileIconBubble({required this.item});

  @override
  Widget build(BuildContext context) {
    final (icon, grad) = _iconAndGradient();
    return Container(
      width: 44,
      height: 44,
      decoration: BoxDecoration(
        gradient: grad,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Icon(icon, color: Colors.white, size: 22),
    );
  }

  (IconData, LinearGradient) _iconAndGradient() {
    if (item.isDirectory) {
      return (
        Icons.folder_rounded,
        const LinearGradient(
            colors: [Color(0xFF818CF8), Color(0xFF6366F1)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight)
      );
    }
    final ext = (item.extension ?? '').toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'heic']
        .contains(ext)) {
      return (
        Icons.image_rounded,
        const LinearGradient(
            colors: [Color(0xFFF472B6), Color(0xFFEC4899)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight)
      );
    }
    if (['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm'].contains(ext)) {
      return (
        Icons.play_circle_filled_rounded,
        const LinearGradient(
            colors: [Color(0xFFA78BFA), Color(0xFF7C3AED)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight)
      );
    }
    if (['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a'].contains(ext)) {
      return (
        Icons.music_note_rounded,
        const LinearGradient(
            colors: [Color(0xFF60A5FA), Color(0xFF2563EB)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight)
      );
    }
    if (['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt']
        .contains(ext)) {
      return (
        Icons.description_rounded,
        const LinearGradient(
            colors: [Color(0xFFFB923C), Color(0xFFEA580C)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight)
      );
    }
    if (['apk'].contains(ext)) {
      return (
        Icons.android_rounded,
        const LinearGradient(
            colors: [Color(0xFF4ADE80), Color(0xFF16A34A)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight)
      );
    }
    if (['zip', 'rar', '7z', 'tar', 'gz'].contains(ext)) {
      return (
        Icons.archive_rounded,
        const LinearGradient(
            colors: [Color(0xFFA16207), Color(0xFF78350F)],
            begin: Alignment.topLeft,
            end: Alignment.bottomRight)
      );
    }
    return (
      Icons.insert_drive_file_rounded,
      const LinearGradient(
          colors: [Color(0xFF94A3B8), Color(0xFF64748B)],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight)
    );
  }
}

// ── Type Badge ────────────────────────────────────────────────────────────

class _TypeBadge extends StatelessWidget {
  final String label;
  const _TypeBadge(this.label);

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(left: 6),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: const Color(0xFF667EEA).withOpacity(.15),
        borderRadius: BorderRadius.circular(5),
      ),
      child: Text(
        label,
        style: const TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.w700,
          color: Color(0xFF667EEA),
          letterSpacing: .4,
        ),
      ),
    );
  }
}
