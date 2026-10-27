# Gets the Apple side ready for automatic signing, with the App Store Connect
# API key: at least one registered iPhone (a placeholder if there are none),
# and an App ID with App Groups for the app and each extension. Xcode 26.6
# can't create these itself with an API key (it reports a misleading
# "Authentication failed").
require "openssl"; require "json"; require "net/http"; require "base64"
key_id, issuer, path = ENV.fetch("ASC_KEY_ID"), ENV.fetch("ASC_ISSUER_ID"), ENV.fetch("ASC_KEY_PATH")
b64 = ->(s) { Base64.urlsafe_encode64(s, padding: false) }
key = OpenSSL::PKey::EC.new(File.read(path))
head = b64.(JSON.dump(alg: "ES256", kid: key_id, typ: "JWT"))
body = b64.(JSON.dump(iss: issuer, iat: Time.now.to_i, exp: Time.now.to_i + 600, aud: "appstoreconnect-v1"))
der = key.dsa_sign_asn1(OpenSSL::Digest::SHA256.digest("#{head}.#{body}"))
raw = OpenSSL::ASN1.decode(der).value.map { |i| i.value.to_s(2).rjust(32, "\x00") }.join
jwt = "#{head}.#{body}.#{b64.(raw)}"
api = ->(method, url, payload = nil) {
  uri = URI(url); req = (method == :get ? Net::HTTP::Get : Net::HTTP::Post).new(uri)
  req["Authorization"] = "Bearer #{jwt}"; req["Content-Type"] = "application/json"; req.body = JSON.dump(payload) if payload
  res = Net::HTTP.start(uri.host, uri.port, use_ssl: true) { |h| h.request(req) }
  [res.code.to_i, (JSON.parse(res.body) rescue {})]
}

bundles = { "com.grahamdeno.shoebox" => "Shoebox", "com.grahamdeno.shoebox.share" => "Shoebox Share", "com.grahamdeno.shoebox.widget" => "Shoebox Widget" }
bundles.each do |ident, name|
  code, found = api.(:get, "https://api.appstoreconnect.apple.com/v1/bundleIds?filter[identifier]=#{ident}&include=bundleIdCapabilities&limit=5")
  abort "::error::bundle lookup failed (#{code}): #{found}" unless code == 200
  rec = (found["data"] || []).find { |b| b.dig("attributes", "identifier") == ident }
  unless rec
    code, made = api.(:post, "https://api.appstoreconnect.apple.com/v1/bundleIds",
      { data: { type: "bundleIds", attributes: { identifier: ident, name: name, platform: "IOS" } } })
    abort "::error::couldn't register #{ident} (#{code}): #{made}" unless [200, 201].include?(code)
    rec = made["data"]; found = { "included" => [] }
    puts "::notice::Registered App ID #{ident}"
  end
  caps = (found["included"] || []).select { |c| c["type"] == "bundleIdCapabilities" }.map { |c| c.dig("attributes", "capabilityType") }
  next if caps.include?("APP_GROUPS")
  code, out = api.(:post, "https://api.appstoreconnect.apple.com/v1/bundleIdCapabilities",
    { data: { type: "bundleIdCapabilities", attributes: { capabilityType: "APP_GROUPS" },
              relationships: { bundleId: { data: { type: "bundleIds", id: rec["id"] } } } } })
  puts(([200, 201].include?(code)) ? "::notice::App Groups on for #{ident}" : "::warning::App Groups for #{ident}: #{code} #{out.to_s[0, 300]}")
end
code, list = api.(:get, "https://api.appstoreconnect.apple.com/v1/devices?filter[platform]=IOS&limit=5")
abort "::error::devices lookup failed (#{code}): #{list}" unless code == 200
if (list["data"] || []).empty?
  code, out = api.(:post, "https://api.appstoreconnect.apple.com/v1/devices",
    { data: { type: "devices", attributes: { name: "Shoebox build placeholder", platform: "IOS", udid: "00008110-001A2B3C4D5E6F01" } } })
  abort "::error::device registration failed (#{code}): #{out}" unless [200, 201].include?(code)
  puts "::notice::Registered a placeholder iPhone for signing"
else
  puts "::notice::Team has #{list['data'].size} registered device(s)"
end
