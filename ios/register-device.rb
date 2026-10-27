# Makes sure the team has at least one registered iPhone, so Xcode's automatic
# signing can make the development profile it signs the archive with. Uses the
# App Store Connect API key. Registers a placeholder only if there are none.
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
