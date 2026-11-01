// What `typescript` resolves to in the Worker's bundle. Graphile Worker's
// config reader (cosmiconfig) requires it only to read a .ts config file, which
// the edge never has, but the bundler must resolve the name all the same.
export default {}
