class ServerInfo {
  final String ip;
  final int port;
  final int fastPort;
  final String directory;
  final String version;

  const ServerInfo({
    required this.ip,
    required this.port,
    required this.fastPort,
    required this.directory,
    required this.version,
  });

  String get baseUrl => 'http://$ip:$port';
  String get fastBaseUrl => 'http://$ip:$fastPort';

  factory ServerInfo.fromJson(Map<String, dynamic> json) {
    return ServerInfo(
      ip: json['ip'] as String? ?? '',
      port: (json['port'] as num?)?.toInt() ?? 5001,
      fastPort: (json['fast_port'] as num?)?.toInt() ?? 5002,
      directory: json['directory'] as String? ?? '',
      version: json['version'] as String? ?? '1.0',
    );
  }

  @override
  String toString() => 'ServerInfo($ip:$port, fast=$fastPort)';
}
