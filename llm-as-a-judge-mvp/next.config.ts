import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  webpack(config, { isServer }) {
    // YAMLをビルド時にバンドル（Vercel等サーバーレスでreadFileが失敗するため）
    if (isServer) {
      config.module.rules.push({
        test: /\.ya?ml$/,
        type: "asset/source"
      });
    }
    return config;
  }
};

export default nextConfig;
