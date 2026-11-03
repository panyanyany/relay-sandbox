FROM mitmproxy/mitmproxy:12.3.1@sha256:2711066c855659b5af8b1dbb84494ed3eff69b42ece439c60b4fe09a2db829d4
# 固定成熟代理版本；只加入最小匹配器与写盘前筛选插件。
COPY scripts/traffic-match.py scripts/traffic-addon.py scripts/traffic_context.py /opt/relay/
ENTRYPOINT ["mitmdump"]
